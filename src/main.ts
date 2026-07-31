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
import { SyncStatusView, VIEW_TYPE_SYNC_STATUS } from "./view";
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

/**
 * Lucide icon per state for the status bar. The icon is also the button that
 * starts and pauses syncing, so the not-running states use "play": a pause glyph
 * on a control that resumes reads backwards once it is clickable.
 */
const STATUS_ICON: Record<SyncState, string> = {
	[SYNC_STATE.IDLE]: "play",
	[SYNC_STATE.CONNECTING]: "plug",
	[SYNC_STATE.SYNCING]: "refresh-cw",
	[SYNC_STATE.SYNCED]: "check",
	[SYNC_STATE.OFFLINE]: "cloud-off",
	[SYNC_STATE.PAUSED]: "play",
	[SYNC_STATE.ERROR]: "alert-triangle",
};

export default class CouchDBSyncPlugin extends Plugin {
	settings!: CouchDBSyncSettings;
	private db: SyncDatabase | null = null;
	private engine: SyncEngine | null = null;
	/**
	 * De-dupes concurrent index reports. The settings view (3 s) and the status-bar
	 * drift summary (5 s) both ask for one, and a report is expensive (a hidden-file
	 * walk plus a decrypt of every file doc). Sharing ONE in-flight promise across
	 * every caller — running session or idle — means overlapping timers can never
	 * stack full scans on top of each other.
	 */
	private reportInFlight: Promise<IndexReport | null> | null = null;
	/** guards the idle auto-resolver so overlapping refresh ticks don't stack it */
	private resolvingIdle = false;
	/** cached legacy-cache doc count (probed at most once per session) */
	private legacyDocCountCache: number | null = null;
	private statusEl!: HTMLElement;
	private statusIconEl!: HTMLElement;
	private statusTextEl!: HTMLElement;
	private restartLock: Promise<void> = Promise.resolve();

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

		// Status bar: two controls, not one label. The icon drives the session
		// (start / pause), the text opens the full status panel. Both are reachable
		// without going through settings, which is where they are needed most.
		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("couchdb-sync-status");
		this.statusIconEl = this.statusEl.createSpan({
			cls: "couchdb-sync-status-icon couchdb-sync-status-btn",
		});
		this.statusTextEl = this.statusEl.createSpan({
			cls: "couchdb-sync-status-text couchdb-sync-status-btn",
		});
		this.statusIconEl.onclick = () => void this.toggleSessionFromStatusBar();
		this.statusTextEl.onclick = () => void this.revealStatusView();
		// Paint directly rather than via setStatus: the status already IS the initial
		// idle state, and setStatus short-circuits on an unchanged status — which
		// would leave the bar blank until something else happened to change it.
		this.renderStatusBar();

		this.registerView(VIEW_TYPE_SYNC_STATUS, (leaf) => new SyncStatusView(leaf, this));

		this.addSettingTab(new CouchDBSyncSettingTab(this.app, this));

		this.addCommand({
			id: "couchdb-sync-open-panel",
			name: "Open sync status panel",
			callback: () => void this.revealStatusView(),
		});

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
			id: "couchdb-sync-toggle",
			name: "Turn sync on/off",
			callback: () => this.setSyncEnabled(!this.settings.syncEnabled),
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
		// unsafeShutdown=true. Switch sync OFF so the plugin can never get stuck in a
		// start-crash loop — and do it on the VISIBLE master switch, so the state the
		// user sees ("SYNC OFF", with the reason next to it) is the state the plugin
		// is actually in. Turning it back on is one click once the problem is fixed.
		const crashed = this.settings.unsafeShutdown;
		if (crashed) {
			this.settings.unsafeShutdown = false;
			this.settings.syncEnabled = false;
			await this.saveSettings();
			new Notice(
				"CouchDB Sync: the previous sync did not finish cleanly, so sync has been " +
					"switched OFF. Fix the issue (or wipe the local cache), then switch sync back on.",
				12000
			);
		}

		if (!this.settings.syncEnabled) {
			// Master switch off — stay fully idle, no network, until it is switched on.
			// Only the crash case carries a detail; for a plain "off" the status card
			// derives the wording from the live state.
			this.setStatus(
				SYNC_STATE.IDLE,
				crashed ? "Stopped after an unclean shutdown — switch sync on to resume." : undefined
			);
		} else {
			// Sync is on, so it runs: start once the layout is ready, so the initial
			// scan sees a settled vault.
			this.app.workspace.onLayoutReady(() => void this.restartSync());
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
		this.engine?.abort();
		await this.restartLock.catch(() => undefined); // let any in-flight start wind down
		this.engine?.stop();
		// Drain any in-flight index report before touching the shared handle.
		if (this.reportInFlight) await this.reportInFlight.catch(() => undefined);
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

	private setStatus(state: SyncState, detail?: string): void {
		// Idempotent: the engine signals activity once per indexed file, so a large
		// vault would otherwise re-render the status bar and every listener thousands
		// of times for a status that never changed.
		if (this.status.state === state && this.status.detail === detail) return;

		const wasSyncing = this.status.state === SYNC_STATE.SYNCING;
		this.status = { state, detail };

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

		// Master switch off: show a single, unambiguous "off" indicator and never a
		// syncing spinner or drift % — nothing is being synced, so any progress-style
		// readout would be misleading (the drift summary still ticks for the index view).
		if (!this.settings.syncEnabled) {
			setIcon(this.statusIconEl, "play");
			this.statusIconEl.removeClass("couchdb-sync-spin");
			this.statusTextEl.setText("CouchDB off");
			this.statusEl.setAttr("aria-label", "CouchDB sync: off");
			this.statusIconEl.setAttr("aria-label", "Turn sync on");
			this.statusTextEl.setAttr("aria-label", "Open the sync status panel");
			return;
		}

		let displayed: SyncState = raw.state;
		let label = "CouchDB";
		let ariaSuffix = raw.detail ?? raw.state;

		if (raw.state === SYNC_STATE.ERROR || raw.state === SYNC_STATE.OFFLINE || raw.state === SYNC_STATE.CONNECTING) {
			// these states win unconditionally — drift % would be misleading here
			displayed = raw.state;
		} else if (drift && drift.drift > 0) {
			// Disk and DB still diverge -> not "in sync". Only call it *syncing* (and
			// spin the icon) when a session is actually running; with nothing running
			// a spinner would claim progress that is not happening.
			displayed = this.engine ? SYNC_STATE.SYNCING : SYNC_STATE.PAUSED;
			label = `CouchDB ${drift.pct}%`;
			ariaSuffix = this.engine
				? `syncing ${drift.pct}% — ${drift.drift} pending`
				: `not running — ${drift.pct}% in sync, ${drift.drift} pending`;
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
		// Per-control tooltips: the two halves do different things, so one shared
		// label on the container would be wrong for at least one of them.
		this.statusIconEl.setAttr(
			"aria-label",
			this.engine ? "Pause syncing" : "Sync now"
		);
		this.statusTextEl.setAttr("aria-label", "Open the sync status panel");
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

	/**
	 * Status-bar icon click: drive the current session.
	 *
	 * Same three cases the status card's primary action covers, so the two controls
	 * can never mean different things:
	 *   sync off      -> switch it on (and start)
	 *   running       -> pause this session (the master switch stays on)
	 *   on, but idle  -> start a session
	 * Sync being off is the only case that changes the persisted switch, and only
	 * because it is the sole way to say "go" from the status bar.
	 */
	private async toggleSessionFromStatusBar(): Promise<void> {
		try {
			if (!this.settings.syncEnabled) {
				await this.setSyncEnabled(true);
				new Notice("CouchDB Sync: sync turned on.");
			} else if (this.engine) {
				await this.stopSync();
				new Notice("CouchDB Sync: paused. Click again to resume.");
			} else {
				await this.restartSync();
			}
		} catch (e) {
			new Notice(`CouchDB Sync: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/** Open (or focus) the sync status panel in the right sidebar. */
	async revealStatusView(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_SYNC_STATUS);
		if (existing.length > 0) {
			await workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: VIEW_TYPE_SYNC_STATUS, active: true });
		await workspace.revealLeaf(leaf);
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
		// Master kill switch: the single choke point every start path funnels through.
		// While off, no session may start — keep the engine torn down and stay idle.
		if (!this.settings.syncEnabled) {
			this.engine?.stop();
			this.engine = null;
			// No detail: the status card derives the reason from the live state.
			this.setStatus(SYNC_STATE.IDLE);
			return;
		}
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

		const db = this.getSharedDb();

		// Refuse to replicate into a remote that did NOT fill this local cache.
		// Otherwise repointing the connection at a different server/database and
		// letting sync run (e.g. automatically at launch) would push this vault's
		// docs into the new remote and mix the two. "unset" (fresh cache, first
		// sync) and "match" proceed; only a definite mismatch is blocked, and the
		// user recovers via Wipe local cache / Adopt cache for this remote.
		const origin = await this.checkOriginFingerprint().catch(() => "unset" as const);
		if (origin === "mismatch") {
			this.setStatus(
				SYNC_STATE.ERROR,
				"Local cache belongs to a different server/database. Wipe the local cache or adopt it for this remote before syncing."
			);
			new Notice(
				"CouchDB Sync: this vault's local cache was filled by a different remote. Open settings → 'Wipe local cache' or 'Adopt cache for this remote'."
			);
			return;
		}

		// Arm the crash guard BEFORE doing any heavy work, and persist it to disk.
		// If this run hangs/crashes before reaching a safe state, the next launch
		// sees the flag and starts in safe mode.
		this.settings.unsafeShutdown = true;
		await this.saveSettings();
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
				// Drain any in-flight report so we don't destroy the DB out from
				// under a pending read, then destroy and drop the handle. getSharedDb()
				// re-opens a fresh empty replica on the next read.
				if (this.reportInFlight) await this.reportInFlight.catch(() => undefined);
				await this.getSharedDb().destroyLocal().catch(() => undefined);
				this.db = null;
				this.reportInFlight = null;
				this.setStatus(SYNC_STATE.IDLE, "local cache wiped — press Sync now to re-download");
			});
		return this.restartLock;
	}

	/**
	 * Stop the CURRENT session and go idle, without touching the master switch: a
	 * session-level action, so "Sync now" starts it again and the next launch still
	 * syncs. Turning sync off for good is the master switch (setSyncEnabled).
	 *
	 * The resulting idle state carries a reason, so the status card can say why
	 * nothing is running instead of showing a bare "Idle".
	 */
	stopSync(): Promise<void> {
		this.engine?.abort();
		this.restartLock = this.restartLock
			.catch(() => undefined)
			.then(() => {
				this.engine?.stop();
				this.engine = null;
				// keep the shared DB handle open so the idle index view still works
				this.setStatus(SYNC_STATE.IDLE, "stopped — press Sync now to resume");
			});
		return this.restartLock;
	}

	/**
	 * Master on/off switch for the entire sync mechanism.
	 *
	 * OFF is a hard, persisted stop: abort and tear down the running session, then
	 * hold everything down. Because `syncEnabled` gates the single restart choke
	 * point (`doRestart`), auto-start, the idle conflict resolver and every per-file
	 * action, nothing can spin sync back up on its own — the switch is authoritative,
	 * not advisory. The shared local DB handle is deliberately kept open so the index
	 * status view keeps working (local reads only; no network).
	 *
	 * ON is a clean start: persist the flag, then run the normal restart path, which
	 * honours the existing `liveSync` preference (continuous vs. one-shot). Flipping
	 * the switch is serialized through `restartLock`, so it can never race a start.
	 */
	async setSyncEnabled(enabled: boolean): Promise<void> {
		if (this.settings.syncEnabled === enabled) return;
		this.settings.syncEnabled = enabled;
		await this.saveSettings();

		if (enabled) {
			await this.restartSync();
			return;
		}

		// Turning OFF: abort fast, then quiesce on the serialized lock.
		this.engine?.abort();
		this.restartLock = this.restartLock
			.catch(() => undefined)
			.then(async () => {
				this.engine?.stop();
				this.engine = null;
				// Keep the shared DB handle OPEN — the idle index view still reads it.
				// No detail: the status card derives the reason from the live state.
				this.setStatus(SYNC_STATE.IDLE);
			});
		await this.restartLock;
	}

	/** Whether the master sync switch is on. */
	isSyncEnabled(): boolean {
		return this.settings.syncEnabled;
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
		// One shared in-flight promise for every caller (see reportInFlight). On top
		// of the single always-open DB handle from getSharedDb, this guarantees there
		// is never a second PouchDB opened/closed on the same name — no IDBDatabase
		// race — and no duplicated hidden-file walk.
		if (this.reportInFlight) return this.reportInFlight;
		const p = this.computeIndexReport();
		this.reportInFlight = p;
		try {
			return await p;
		} finally {
			if (this.reportInFlight === p) this.reportInFlight = null;
		}
	}

	/** Build a fresh index report. Always go through getIndexReport (de-duped). */
	private async computeIndexReport(): Promise<IndexReport | null> {
		if (this.engine) return this.engine.getIndexReport();
		if (!this.settings.serverUrl) return null; // not configured yet
		// Don't expose cached doc paths/names to the user until they have proven
		// they own the configured remote — otherwise typing random text into the
		// URL field is enough to inspect anything the local cache happens to hold.
		if (!this.settings.connectionVerified) return null;
		const db = this.getSharedDb();
		const stored = await db.getLocalDoc<{ fp?: string }>(ORIGIN_FP_DOC).catch(() => null);
		if (stored && stored.fp) {
			const current = await originFingerprint(this.settings);
			if (stored.fp !== current) return null; // mismatch -> hide
		}
		return buildIndexReport(this.app, this.settings, db);
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
		// Respect the master switch: per-file sync actions must not silently power the
		// engine back on while sync is turned off.
		if (!this.settings.syncEnabled) {
			throw new Error("Sync is turned off. Switch it on to run this action.");
		}
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

	/** Resolve a drifting/conflicting file by the configured strategy (never a blind local upload). */
	async resolveByStrategyPath(path: string): Promise<void> {
		const engine = await this.ensureEngine();
		await engine.resolveByStrategy(path);
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
		if (!this.settings.syncEnabled) return 0; // master switch off -> no network work
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

	/** Current text of the DATABASE copy of a file (null if missing or binary). */
	getRemoteText(path: string): Promise<string | null> {
		return this.withReader((e) => e.getRemoteText(path));
	}

	/**
	 * Apply a reconciled text from the side-by-side merge editor: overwrite the local
	 * file and upload it so the database matches, leaving the file fully in sync.
	 * Requires a live session (single mutating code path), so it honours the master
	 * switch via ensureEngine.
	 */
	async applyMergedTextPath(path: string, text: string): Promise<void> {
		const engine = await this.ensureEngine();
		await engine.applyMergedText(path, text);
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
		// Cache the result: the settings tab calls this on every display(), and probing
		// opens a (potentially large) PouchDB just to read its doc count.
		if (this.legacyDocCountCache !== null) return this.legacyDocCountCache;
		// Don't probe our own current DB.
		if (this.settings.localDbId === "" || localDbName(this.settings) === LEGACY_LOCAL_DB_NAME) {
			this.legacyDocCountCache = 0;
			return 0;
		}
		const db = new PouchDB(LEGACY_LOCAL_DB_NAME, { skip_setup: true } as PouchDB.Configuration.LocalDatabaseConfiguration);
		try {
			const info = await db.info();
			this.legacyDocCountCache = info.doc_count ?? 0;
		} catch {
			this.legacyDocCountCache = 0;
		} finally {
			await db.close().catch(() => undefined);
		}
		return this.legacyDocCountCache;
	}

	/** Permanently destroy the legacy vault-shared local PouchDB. */
	async wipeLegacyLocalDb(): Promise<void> {
		const db = new PouchDB(LEGACY_LOCAL_DB_NAME);
		try {
			await db.destroy();
			this.legacyDocCountCache = 0; // gone now — reflect it without re-probing
		} catch (e) {
			console.warn("[couchdb-sync] could not destroy legacy local DB", e);
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
