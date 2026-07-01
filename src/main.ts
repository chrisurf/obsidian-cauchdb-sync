import { Notice, Plugin, setIcon } from "obsidian";
import PouchDB from "pouchdb-browser";
import {
	CouchDBSyncSettings,
	CURRENT_SETTINGS_VERSION,
	DEFAULT_SETTINGS,
	SYNC_STATE,
	SyncState,
	SyncStatus,
	VersionDoc,
} from "./types";
import { migrateSettings } from "./migrate";
import { SyncDatabase } from "./database";
import { SyncEngine, IndexReport, buildIndexReport, removeFromDb } from "./engine";
import { CouchDBSyncSettingTab } from "./settings";
import { generateDeviceId, sha256Hex, textToBytes } from "./util";

/** _local doc id under which we remember which remote this cache belongs to. */
const ORIGIN_FP_DOC = "_local/couchdb-sync-origin";

/**
 * Stable fingerprint of the "remote identity" — the tuple that determines
 * which remote a local cache belongs to. Username is included so two users
 * sharing the same server+database are still distinguishable.
 */
async function originFingerprint(settings: CouchDBSyncSettings): Promise<string> {
	const norm = `${settings.serverUrl.trim().replace(/\/+$/, "")}|${settings.dbName.trim()}|${settings.username.trim()}`;
	return sha256Hex(textToBytes(norm));
}

/**
 * Obsidian runs all vaults under the same Electron origin (`app://obsidian.md`),
 * so a hardcoded local PouchDB name would be shared across every vault on the
 * machine — leaking files between vaults and risking cross-vault writes. We
 * therefore derive the name from a random per-vault id persisted in this
 * vault's data.json (which Obsidian already scopes per-vault).
 */
const LOCAL_DB_PREFIX = "couchdb-sync-local";
const LEGACY_LOCAL_DB_NAME = "couchdb-sync-local"; // pre-vault-isolation default

function localDbName(settings: CouchDBSyncSettings): string {
	return `${LOCAL_DB_PREFIX}-${settings.localDbId}`;
}

// Lucide icon name per state for the status bar.
const STATUS_ICON: Record<SyncState, string> = {
	[SYNC_STATE.IDLE]: "pause",
	[SYNC_STATE.CONNECTING]: "plug",
	[SYNC_STATE.SYNCING]: "refresh-cw",
	[SYNC_STATE.SYNCED]: "check",
	[SYNC_STATE.OFFLINE]: "cloud-off",
	[SYNC_STATE.PAUSED]: "pause",
	[SYNC_STATE.ERROR]: "alert-triangle",
};

export default class CouchDBSyncPlugin extends Plugin {
	settings!: CouchDBSyncSettings;
	private db: SyncDatabase | null = null;
	private engine: SyncEngine | null = null;
	/** de-dupes concurrent idle index reports (the 3s settings + 5s drift timers) */
	private idleReportInFlight: Promise<IndexReport | null> | null = null;
	/** guards the idle auto-resolver so overlapping refresh ticks don't stack it */
	private resolvingIdle = false;
	private statusEl!: HTMLElement;
	private statusIconEl!: HTMLElement;
	private statusTextEl!: HTMLElement;
	private restartLock: Promise<void> = Promise.resolve();
	private emergencyStopUntil = 0;
	private emergencyTimer?: ReturnType<typeof setTimeout>;

	/** Latest status, shared with the settings view via listeners. */
	status: SyncStatus = { state: SYNC_STATE.IDLE };
	private statusListeners = new Set<(s: SyncStatus) => void>();

	/**
	 * Cached drift summary from the most recent index report. Used by the status
	 * bar so the checkmark only appears when truly 100 % synced — engine SYNCED
	 * alone is not enough (replication can be idle while disk and DB still
	 * diverge, e.g. cached docs not yet materialized).
	 */
	private effectiveDrift: { drift: number; pct: number } | null = null;
	private driftRefreshTimer: number | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("couchdb-sync-status");
		this.statusIconEl = this.statusEl.createSpan({ cls: "couchdb-sync-status-icon" });
		this.statusTextEl = this.statusEl.createSpan({ cls: "couchdb-sync-status-text" });
		this.setStatus(SYNC_STATE.IDLE);

		this.addSettingTab(new CouchDBSyncSettingTab(this.app, this));

		this.addCommand({
			id: "couchdb-sync-now",
			name: "Sync now",
			callback: () => this.restartSync(),
		});

		this.addCommand({
			id: "couchdb-sync-stop",
			name: "Stop sync",
			callback: () => this.stopSync(),
		});

		this.addCommand({
			id: "couchdb-sync-wipe-local",
			name: "Wipe local cache (does not download)",
			callback: async () => {
				await this.wipeLocalOnly();
				new Notice("CouchDB Sync: local cache wiped. Use 'Sync now' to re-download.");
			},
		});

		// Crash guard: if the previous session never reached a safe state, it left
		// unsafeShutdown=true. In that case turn auto-start OFF and KEEP it off across
		// restarts, so the plugin can never get stuck in an auto-start crash loop. The
		// user re-enables "Start sync automatically" once the problem is fixed.
		if (this.settings.unsafeShutdown) {
			this.settings.unsafeShutdown = false;
			this.settings.autoStart = false;
			await this.saveSettings();
			new Notice(
				"CouchDB Sync: the previous sync did not finish cleanly, so auto-start has been " +
					"turned OFF. Fix the issue (or Reset), then re-enable 'Start sync automatically'.",
				12000
			);
		}

		if (this.settings.autoStart) {
			// Start after the layout is ready so the initial scan sees a settled vault.
			this.app.workspace.onLayoutReady(() => void this.restartSync());
		} else {
			this.setStatus(SYNC_STATE.IDLE, "auto-start off");
		}

		// Keep the status bar honest: the engine reports SYNCED as soon as
		// replication is idle, but disk and DB can still be out of sync. The
		// status bar should only show the checkmark when drift is truly zero,
		// so we recompute the drift summary on a slow tick and re-render.
		this.driftRefreshTimer = window.setInterval(
			() => void this.refreshDriftSummary(),
			5000
		);
		this.register(() => {
			if (this.driftRefreshTimer !== null) {
				window.clearInterval(this.driftRefreshTimer);
				this.driftRefreshTimer = null;
			}
		});
		// First read once the layout has had a moment to settle (don't block onload).
		window.setTimeout(() => void this.refreshDriftSummary(), 1500);
	}

	async onunload(): Promise<void> {
		if (this.emergencyTimer) clearTimeout(this.emergencyTimer);
		this.engine?.abort();
		await this.restartLock.catch(() => undefined); // let any in-flight start wind down
		this.engine?.stop();
		// Drain any in-flight idle index report before touching the shared handle.
		if (this.idleReportInFlight) await this.idleReportInFlight.catch(() => undefined);
		// Privacy mode: destroy the local PouchDB before closing so the cached
		// metadata is not left behind when the plugin is disabled. Must run
		// BEFORE close() (destroy on a closed handle is a no-op in PouchDB).
		if (this.settings.forgetCacheOnDisable) {
			try {
				await this.getSharedDb().destroyLocal();
			} catch (e) {
				console.warn("[couchdb-sync] forget-on-disable failed", e);
			}
			this.db = null; // already destroyed; don't try to close()
		}
		await this.db?.close().catch(() => undefined);
		this.engine = null;
		this.db = null;
		// clean shutdown -> not a crash
		this.settings.unsafeShutdown = false;
		await this.saveSettings().catch(() => undefined);
	}

	private setStatus(
		state: SyncState,
		detail?: string,
		progress?: { done: number; total: number }
	): void {
		const wasSyncing = this.status.state === SYNC_STATE.SYNCING;
		this.status = { state, detail, done: progress?.done, total: progress?.total };

		if (state === SYNC_STATE.ERROR && detail) console.error("[couchdb-sync]", detail);

		this.renderStatusBar();
		for (const cb of this.statusListeners) cb(this.status);

		// Just settled? Refresh the drift summary so the bar can flip from a %
		// to the checkmark immediately, without waiting for the periodic tick.
		if (wasSyncing && state === SYNC_STATE.SYNCED) {
			void this.refreshDriftSummary();
		}
	}

	/**
	 * Combine the raw engine state with the cached drift summary into the icon,
	 * label and ARIA description of the status bar. The checkmark is only shown
	 * when both: the engine is idle/synced AND drift is exactly zero. Any
	 * pending drift forces the syncing icon plus the real percentage.
	 */
	private renderStatusBar(): void {
		const raw = this.status;
		const drift = this.effectiveDrift;

		let displayed: SyncState = raw.state;
		let label = "CouchDB";
		let ariaSuffix = raw.detail ?? raw.state;

		const engineSyncingWithProgress =
			raw.state === SYNC_STATE.SYNCING && raw.total !== undefined && raw.total > 0;

		if (raw.state === SYNC_STATE.ERROR || raw.state === SYNC_STATE.OFFLINE || raw.state === SYNC_STATE.CONNECTING) {
			// these states win unconditionally — drift % would be misleading here
			displayed = raw.state;
		} else if (engineSyncingWithProgress) {
			// initial index pass etc. — engine knows the exact progress
			displayed = SYNC_STATE.SYNCING;
			const pct = Math.round((raw.done! / raw.total!) * 100);
			label = `CouchDB ${pct}%`;
			ariaSuffix = `syncing ${pct}% — ${raw.detail ?? "indexing"}`;
		} else if (drift && drift.drift > 0) {
			// engine settled but disk and DB still diverge -> not "in sync"
			displayed = SYNC_STATE.SYNCING;
			label = `CouchDB ${drift.pct}%`;
			ariaSuffix = `syncing ${drift.pct}% — ${drift.drift} pending`;
		} else if (
			drift &&
			drift.drift === 0 &&
			(raw.state === SYNC_STATE.SYNCED || raw.state === SYNC_STATE.IDLE || raw.state === SYNC_STATE.PAUSED)
		) {
			// truly 100 % in sync
			displayed = SYNC_STATE.SYNCED;
			label = "CouchDB ✓";
			ariaSuffix = "in sync (100%)";
		} else {
			// no drift data yet (gated, before first report, or after error). Stay
			// neutral — do NOT show the checkmark just because the engine is idle.
			displayed = raw.state === SYNC_STATE.SYNCED ? SYNC_STATE.IDLE : raw.state;
		}

		setIcon(this.statusIconEl, STATUS_ICON[displayed]);
		this.statusIconEl.toggleClass("couchdb-sync-spin", displayed === SYNC_STATE.SYNCING);
		this.statusTextEl.setText(label);
		this.statusEl.setAttr("aria-label", `CouchDB sync: ${ariaSuffix}`);
	}

	/** Recompute the cached drift summary from the current index report. */
	private async refreshDriftSummary(): Promise<void> {
		try {
			const report = await this.getIndexReport();
			if (!report) {
				this.effectiveDrift = null;
			} else {
				const drift = report.localOnly.length + report.dbOnly.length + report.drift.length;
				const total = report.inSync.length + drift;
				const pct = total === 0 ? 100 : Math.round((report.inSync.length / total) * 100);
				this.effectiveDrift = { drift, pct };

				// Idle auto-resolve: when no session is running but the DB still holds
				// unresolved conflicts, clear them by the configured strategy so they
				// don't sit red forever waiting for the next full "Sync now". Guarded so
				// overlapping 5s/3s ticks never stack it.
				if (!this.engine && report.conflicts.length > 0 && !this.resolvingIdle) {
					this.resolvingIdle = true;
					void this.resolveConflictsIdle()
						.then((n) => {
							if (n > 0) void this.refreshDriftSummary();
						})
						.catch((e) => console.warn("[couchdb-sync] idle conflict resolve failed", e))
						.finally(() => {
							this.resolvingIdle = false;
						});
				}
			}
		} catch {
			// silent: keep whatever we had — the next tick will retry
			return;
		}
		this.renderStatusBar();
	}

	/** Subscribe to status updates (used by the settings view). Returns an unsubscribe. */
	onStatusChange(cb: (s: SyncStatus) => void): () => void {
		this.statusListeners.add(cb);
		cb(this.status);
		return () => this.statusListeners.delete(cb);
	}

	/**
	 * Restart synchronization. Calls are serialized so two restarts (e.g. layout-ready
	 * plus a settings toggle) can never run concurrently and tear down each other's
	 * database mid-scan. A new call first aborts any running session so it stops fast.
	 */
	restartSync(): Promise<void> {
		this.engine?.abort();
		this.restartLock = this.restartLock
			.catch(() => undefined)
			.then(() => this.doRestart("sync"));
		return this.restartLock;
	}

	/** Pull the server's state into this device without uploading (follower mode). */
	downloadFromServer(): Promise<void> {
		this.engine?.abort();
		this.restartLock = this.restartLock
			.catch(() => undefined)
			.then(() => this.doRestart("download"));
		return this.restartLock;
	}

	private async doRestart(mode: "sync" | "download" = "sync"): Promise<void> {
		if (this.getEmergencyRemaining() > 0) return;
		this.engine?.stop();
		this.engine = null;
		// Keep the shared local DB handle OPEN across restarts (see getSharedDb): the
		// engine and idle readers share ONE handle, so it must never be closed here.

		if (!this.settings.serverUrl || !this.settings.username) {
			this.setStatus(SYNC_STATE.IDLE);
			new Notice("CouchDB Sync: please configure the server connection in settings.");
			return;
		}
		if (this.settings.e2eeEnabled && !this.settings.passphrase) {
			this.setStatus(SYNC_STATE.ERROR, "Encryption is on but no passphrase is set.");
			new Notice("CouchDB Sync: set an encryption passphrase (or disable encryption).");
			return;
		}

		// Arm the crash guard BEFORE doing any heavy work, and persist it to disk.
		// If this run hangs/crashes before reaching a safe state, the next launch
		// sees the flag and starts in safe mode.
		this.settings.unsafeShutdown = true;
		await this.saveSettings();

		const db = this.getSharedDb();
		const engine = new SyncEngine(
			this.app,
			db,
			this.settings,
			(s, d) => this.setStatus(s, d),
			() => void this.markCleanState() // initial index finished -> disarm guard
		);
		this.engine = engine;
		try {
			if (mode === "download") await engine.startDownloadOnly();
			else await engine.start();
		} catch (e) {
			this.setStatus(SYNC_STATE.ERROR, String(e));
			new Notice(`CouchDB Sync failed to start: ${e}`);
		}
	}

	/** Clear the crash guard once a session has reached a safe steady state. */
	private async markCleanState(): Promise<void> {
		let dirty = false;
		if (this.settings.unsafeShutdown) {
			this.settings.unsafeShutdown = false;
			dirty = true;
		}
		// Reaching a steady-state sync proves the remote credentials work, so the
		// index status view is now safe to show without the user re-running Test.
		if (!this.settings.connectionVerified) {
			this.settings.connectionVerified = true;
			dirty = true;
		}
		if (dirty) await this.saveSettings();
		// Reaching steady state also means this local cache is now legitimately
		// tied to the configured remote — record the fingerprint so a later
		// credential change can be detected.
		await this.stampOriginFingerprint();
	}

	/** Mark the configured connection as verified (called by the Test button on success). */
	async markConnectionVerified(): Promise<void> {
		if (this.settings.connectionVerified) return;
		this.settings.connectionVerified = true;
		await this.saveSettings();
	}

	/** Reset the verified flag — required whenever serverUrl/dbName/username change. */
	async invalidateConnection(): Promise<void> {
		if (!this.settings.connectionVerified) return;
		this.settings.connectionVerified = false;
		await this.saveSettings();
	}

	/**
	 * Compare the cache's stored origin fingerprint against the current settings.
	 * Returns null when there is no stored fingerprint yet (fresh DB or pre-fingerprint
	 * data), 'match' when they agree, or 'mismatch' when the cache was filled by a
	 * different remote — in which case the index view must NOT be shown without an
	 * explicit user action (otherwise switching credentials would silently surface
	 * the previous remote's filenames).
	 */
	async checkOriginFingerprint(): Promise<"match" | "mismatch" | "unset"> {
		// One shared, always-open handle (getSharedDb) is used by the engine and all
		// idle readers alike, so there is no second connection to close out from under
		// a pending transaction (the old IDBDatabase "connection is closing" bug).
		const stored = await this.getSharedDb()
			.getLocalDoc<{ fp?: string }>(ORIGIN_FP_DOC)
			.catch(() => null);
		if (!stored || !stored.fp) return "unset";
		const current = await originFingerprint(this.settings);
		return stored.fp === current ? "match" : "mismatch";
	}

	/** Stamp the current origin fingerprint into the cache so we recognize it later. */
	async stampOriginFingerprint(): Promise<void> {
		try {
			const fp = await originFingerprint(this.settings);
			await this.getSharedDb().putLocalDoc(ORIGIN_FP_DOC, { fp });
		} catch (e) {
			console.warn("[couchdb-sync] could not stamp origin fingerprint", e);
		}
	}

	/**
	 * Wipe the LOCAL replica only (fast). Does NOT download — the user starts that
	 * separately with "Sync now". The server data is untouched.
	 */
	wipeLocalOnly(): Promise<void> {
		this.engine?.abort();
		this.restartLock = this.restartLock
			.catch(() => undefined)
			.then(async () => {
				this.engine?.stop();
				this.engine = null;
				// Drain any in-flight idle report so we don't destroy the DB out from
				// under a pending read, then destroy and drop the handle. getSharedDb()
				// re-opens a fresh empty replica on the next read.
				if (this.idleReportInFlight) await this.idleReportInFlight.catch(() => undefined);
				await this.getSharedDb().destroyLocal().catch(() => undefined);
				this.db = null;
				this.idleReportInFlight = null;
				this.setStatus(SYNC_STATE.IDLE, "local cache wiped — press Sync now to re-download");
			});
		return this.restartLock;
	}

	/**
	 * Stop syncing and go idle. Also turns OFF live sync and auto-start so the state
	 * is consistent — otherwise the toggles would fight this and sync could resume.
	 */
	stopSync(): Promise<void> {
		this.engine?.abort();
		this.restartLock = this.restartLock
			.catch(() => undefined)
			.then(async () => {
				this.engine?.stop();
				this.engine = null;
				// keep the shared DB handle open so the idle index view still works
				this.settings.liveSync = false;
				this.settings.autoStart = false;
				await this.saveSettings();
				this.setStatus(SYNC_STATE.IDLE, "stopped");
			});
		return this.restartLock;
	}

	/**
	 * Emergency stop: halt sync immediately for a cooldown period without
	 * changing any settings. After the cooldown, sync resumes automatically
	 * if auto-start / live sync are enabled.
	 */
	emergencyStop(seconds = 30): void {
		if (this.emergencyTimer) clearTimeout(this.emergencyTimer);
		this.emergencyStopUntil = Date.now() + seconds * 1000;
		this.engine?.abort();
		this.restartLock = this.restartLock
			.catch(() => undefined)
			.then(async () => {
				this.engine?.stop();
				this.engine = null;
				// keep the shared DB handle open (idle reads); only the engine pauses
				this.setStatus(SYNC_STATE.PAUSED, `emergency stop (${seconds}s)`);
			});
		this.emergencyTimer = setTimeout(() => {
			this.emergencyStopUntil = 0;
			this.emergencyTimer = undefined;
			if (this.settings.autoStart || this.settings.liveSync) {
				void this.restartSync();
			} else {
				this.setStatus(SYNC_STATE.IDLE, "emergency stop ended");
			}
		}, seconds * 1000);
	}

	/** Seconds remaining on the emergency stop cooldown, or 0. */
	getEmergencyRemaining(): number {
		if (this.emergencyStopUntil === 0) return 0;
		return Math.max(0, Math.ceil((this.emergencyStopUntil - Date.now()) / 1000));
	}

	/** Whether a sync session is currently active. */
	isRunning(): boolean {
		return this.engine !== null;
	}

	/**
	 * The single shared local DB handle. Opened lazily and kept OPEN for the whole
	 * plugin lifetime (closed only on unload, destroyed only on wipe). The engine AND
	 * every idle reader use THIS one handle, so we never open a second PouchDB with
	 * the same name and then close it out from under a pending transaction — which was
	 * the root cause of "Failed to execute 'transaction' on 'IDBDatabase': The database
	 * connection is closing." Concurrent reads on one handle are safe; it was the
	 * per-call open/close pairs racing across the 3s and 5s timers that broke.
	 */
	private getSharedDb(): SyncDatabase {
		if (!this.db) this.db = new SyncDatabase(this.settings, localDbName(this.settings));
		return this.db;
	}

	/**
	 * Index/drift report for the settings view. Works even when sync is idle: if no
	 * session is running, it reads the local DB directly so the user always sees the
	 * full picture (counts, percentage, file tree — including hidden files).
	 */
	async getIndexReport(): Promise<IndexReport | null> {
		if (this.engine) return this.engine.getIndexReport();
		if (!this.settings.serverUrl) return null; // not configured yet
		// Don't expose cached doc paths/names to the user until they have proven
		// they own the configured remote — otherwise typing random text into the
		// URL field is enough to inspect anything the local cache happens to hold.
		if (!this.settings.connectionVerified) return null;
		// De-dupe overlapping idle reports: the 3s settings timer and the 5s drift
		// timer can fire together. Sharing one in-flight promise (on top of the one
		// shared, always-open DB handle from getSharedDb) means there is never a
		// second PouchDB opened/closed on the same name — no IDBDatabase race.
		if (this.idleReportInFlight) return this.idleReportInFlight;
		const p = (async (): Promise<IndexReport | null> => {
			const db = this.getSharedDb();
			const stored = await db.getLocalDoc<{ fp?: string }>(ORIGIN_FP_DOC).catch(() => null);
			if (stored && stored.fp) {
				const current = await originFingerprint(this.settings);
				if (stored.fp !== current) return null; // mismatch -> hide
			}
			return await buildIndexReport(this.app, this.settings, db);
		})();
		this.idleReportInFlight = p;
		try {
			return await p;
		} finally {
			if (this.idleReportInFlight === p) this.idleReportInFlight = null;
		}
	}

	/** UI helper: state of the origin fingerprint for the current settings. */
	getOriginState(): Promise<"match" | "mismatch" | "unset"> {
		return this.checkOriginFingerprint();
	}

	/** Files currently being transferred with chunk progress (for live highlighting). */
	getActiveTransfers(): { path: string; done: number; total: number }[] {
		return this.engine?.getActiveTransfers() ?? [];
	}

	/**
	 * Ensure a sync session is running, starting one if needed, and return the engine.
	 * All mutating per-file actions go through the engine (single code path for
	 * chunking/encryption/IO), so they require a live session.
	 */
	private async ensureEngine(): Promise<SyncEngine> {
		if (!this.engine) await this.restartSync();
		if (!this.engine) throw new Error("Sync is not configured. Set up the connection first.");
		return this.engine;
	}

	/** Force (re)sync a single file. Starts a session first if none is running. */
	async forceSyncPath(path: string): Promise<void> {
		const engine = await this.ensureEngine();
		await engine.forceSync(path);
	}

	/** Overwrite this device's copy with the database version. */
	async takeRemotePath(path: string): Promise<void> {
		const engine = await this.ensureEngine();
		await engine.takeRemote(path);
	}

	/** Compare timestamps and take whichever version is newer. */
	async useNewestPath(path: string): Promise<"local" | "remote"> {
		const engine = await this.ensureEngine();
		return engine.useNewest(path);
	}

	/** Overwrite the database with this device's copy. */
	async takeLocalPath(path: string): Promise<void> {
		const engine = await this.ensureEngine();
		await engine.takeLocal(path);
	}

	/** Delete a file on this device only (the server keeps its copy). */
	async deleteLocalPath(path: string): Promise<void> {
		const engine = await this.ensureEngine();
		await engine.deleteLocalOnly(path);
	}

	/** Delete a file everywhere (propagating tombstone + local removal). */
	async deleteEverywherePath(path: string): Promise<void> {
		const engine = await this.ensureEngine();
		await engine.deleteEverywhere(path);
	}

	/**
	 * Run a READ-ONLY engine operation. Uses the live engine when one is running;
	 * otherwise spins up a transient, NON-started engine bound to a transient DB so
	 * that merely viewing history never kicks off a full live sync. The transient DB
	 * connects to the remote so chunk reads can fall back to the server.
	 */
	private async withReader<T>(fn: (engine: SyncEngine) => Promise<T>): Promise<T> {
		if (this.engine) return fn(this.engine);
		if (!this.settings.serverUrl) throw new Error("Sync is not configured.");
		// Reuse the shared, always-open handle (never close it here — idle timers may
		// be reading it concurrently). Connect the remote so chunk reads can fall back
		// to the server for content not yet in the local replica.
		const db = this.getSharedDb();
		try {
			db.connectRemote();
		} catch {
			/* offline reads still work from the local replica */
		}
		const reader = new SyncEngine(this.app, db, this.settings, () => undefined, () => undefined);
		return fn(reader);
	}

	/**
	 * Resolve all outstanding conflicts by the configured strategy — even when no
	 * sync session is running. When a session is live it already auto-resolves, so
	 * this only does work in the idle case, via a transient engine on the shared
	 * handle. Returns how many conflicts were resolved.
	 */
	async resolveConflictsIdle(): Promise<number> {
		if (this.engine) return 0; // a live session resolves conflicts on its own
		if (!this.settings.serverUrl) return 0;
		if (this.settings.e2eeEnabled && !this.settings.passphrase) return 0; // can't read chunks
		const db = this.getSharedDb();
		try {
			db.connectRemote(); // allow chunk reads to fall back to the server
		} catch {
			/* offline: resolve from the local replica only */
		}
		const reader = new SyncEngine(this.app, db, this.settings, () => undefined, () => undefined);
		try {
			return await reader.resolveConflictsStandalone();
		} finally {
			reader.stop(); // cancel its debounced timers; never close the shared handle
		}
	}

	// --- file history ---------------------------------------------------------

	/** All versions of a file, newest first. */
	getFileHistory(path: string): Promise<VersionDoc[]> {
		return this.withReader((e) => e.listHistory(path));
	}

	/** Decoded text of a version (null for binary / deletion entries). */
	getVersionText(v: VersionDoc): Promise<string | null> {
		return this.withReader((e) => e.getVersionText(v));
	}

	/** Current on-disk text of a file (null if missing or binary). */
	getLocalText(path: string): Promise<string | null> {
		return this.withReader((e) => e.getLocalText(path));
	}

	/** Restore an earlier version as the current content everywhere (mutating). */
	async restoreVersion(path: string, v: VersionDoc): Promise<void> {
		const engine = await this.ensureEngine();
		await engine.restoreVersion(path, v);
	}

	/** Remove a file/folder from the DB index (works even when idle). */
	async removeFromIndex(target: string, folder: boolean): Promise<number> {
		if (this.engine) return this.engine.removeFromIndex(target, folder);
		if (!this.settings.serverUrl) return 0;
		return removeFromDb(this.getSharedDb(), target, folder);
	}

	async loadSettings(): Promise<void> {
		// Read the RAW persisted data first: we need the ORIGINAL schemaVersion to
		// decide whether to migrate. (Object.assign with DEFAULT_SETTINGS would
		// otherwise backfill schemaVersion to current and make every old config look
		// already-migrated.)
		const loaded = ((await this.loadData()) ?? null) as
			| (Partial<CouchDBSyncSettings> & Record<string, unknown>)
			| null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
		let dirty = false;

		// One-time settings migration for configs written before CURRENT_SETTINGS_VERSION.
		const priorVersion = (loaded?.schemaVersion as number | undefined) ?? 0;
		if (!loaded || priorVersion < CURRENT_SETTINGS_VERSION) {
			if (migrateSettings(this.settings as CouchDBSyncSettings & Record<string, unknown>, priorVersion)) {
				dirty = true;
			}
			this.settings.schemaVersion = CURRENT_SETTINGS_VERSION;
			dirty = true;
		}

		if (!this.settings.deviceId) {
			this.settings.deviceId = generateDeviceId();
			dirty = true;
		}
		// Vault-isolated local PouchDB name (see LOCAL_DB_PREFIX comment). The id is
		// random so two vaults can never collide even if they share a name or path.
		if (!this.settings.localDbId) {
			this.settings.localDbId = generateDeviceId();
			dirty = true;
		}
		if (dirty) await this.saveSettings();
	}

	/**
	 * Does the legacy, vault-shared PouchDB ("couchdb-sync-local", no suffix) still
	 * exist on this machine and hold data? If yes, it is a leftover from before
	 * vault isolation and the user should explicitly wipe it (we cannot tell which
	 * vault its contents belong to). Returns the doc count, or 0 if absent/empty.
	 */
	async legacyLocalDbDocCount(): Promise<number> {
		// Don't probe our own current DB.
		if (this.settings.localDbId === "" || localDbName(this.settings) === LEGACY_LOCAL_DB_NAME) {
			return 0;
		}
		const db = new PouchDB(LEGACY_LOCAL_DB_NAME, { skip_setup: true } as PouchDB.Configuration.LocalDatabaseConfiguration);
		try {
			const info = await db.info();
			return info.doc_count ?? 0;
		} catch {
			return 0;
		} finally {
			await db.close().catch(() => undefined);
		}
	}

	/** Permanently destroy the legacy vault-shared local PouchDB. */
	async wipeLegacyLocalDb(): Promise<void> {
		const db = new PouchDB(LEGACY_LOCAL_DB_NAME);
		try {
			await db.destroy();
		} catch (e) {
			console.warn("[couchdb-sync] could not destroy legacy local DB", e);
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
