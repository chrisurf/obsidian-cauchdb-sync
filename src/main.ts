import { Notice, Plugin, setIcon } from "obsidian";
import {
	CouchDBSyncSettings,
	DEFAULT_SETTINGS,
	SYNC_STATE,
	SyncState,
	SyncStatus,
} from "./types";
import { SyncDatabase } from "./database";
import { SyncEngine, IndexReport, buildIndexReport, removeFromDb } from "./engine";
import { CouchDBSyncSettingTab } from "./settings";
import { generateDeviceId } from "./util";

const LOCAL_DB_NAME = "couchdb-sync-local";

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
	private statusEl!: HTMLElement;
	private statusIconEl!: HTMLElement;
	private statusTextEl!: HTMLElement;
	private restartLock: Promise<void> = Promise.resolve();

	/** Latest status, shared with the settings view via listeners. */
	status: SyncStatus = { state: SYNC_STATE.IDLE };
	private statusListeners = new Set<(s: SyncStatus) => void>();

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
	}

	async onunload(): Promise<void> {
		this.engine?.abort();
		await this.restartLock.catch(() => undefined); // let any in-flight start wind down
		this.engine?.stop();
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
		this.status = { state, detail, done: progress?.done, total: progress?.total };

		// status bar: spinning icon while syncing, with a percentage when known
		setIcon(this.statusIconEl, STATUS_ICON[state]);
		this.statusIconEl.toggleClass("couchdb-sync-spin", state === SYNC_STATE.SYNCING);
		let label = "CouchDB";
		if (state === SYNC_STATE.SYNCING && progress && progress.total > 0) {
			label = `CouchDB ${Math.round((progress.done / progress.total) * 100)}%`;
		}
		this.statusTextEl.setText(label);
		this.statusEl.setAttr("aria-label", detail ? `${state}: ${detail}` : `CouchDB sync: ${state}`);

		if (state === SYNC_STATE.ERROR && detail) console.error("[couchdb-sync]", detail);

		for (const cb of this.statusListeners) cb(this.status);
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
		this.engine?.stop();
		await this.db?.close().catch(() => undefined);
		this.engine = null;
		this.db = null;

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

		const db = new SyncDatabase(this.settings, LOCAL_DB_NAME);
		const engine = new SyncEngine(
			this.app,
			db,
			this.settings,
			(s, d) => this.setStatus(s, d),
			() => void this.markCleanState() // initial index finished -> disarm guard
		);
		this.db = db;
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
		if (!this.settings.unsafeShutdown) return;
		this.settings.unsafeShutdown = false;
		await this.saveSettings();
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
				const db = this.db ?? new SyncDatabase(this.settings, LOCAL_DB_NAME);
				await db.destroyLocal().catch(() => undefined);
				this.engine = null;
				this.db = null;
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
				await this.db?.close().catch(() => undefined);
				this.engine = null;
				this.db = null;
				this.settings.liveSync = false;
				this.settings.autoStart = false;
				await this.saveSettings();
				this.setStatus(SYNC_STATE.IDLE, "stopped");
			});
		return this.restartLock;
	}

	/** Whether a sync session is currently active. */
	isRunning(): boolean {
		return this.engine !== null;
	}

	/**
	 * Index/drift report for the settings view. Works even when sync is idle: if no
	 * session is running, it reads the local DB directly so the user always sees the
	 * full picture (counts, percentage, file tree — including hidden files).
	 */
	async getIndexReport(): Promise<IndexReport | null> {
		if (this.engine) return this.engine.getIndexReport();
		if (!this.settings.serverUrl) return null; // not configured yet
		const db = new SyncDatabase(this.settings, LOCAL_DB_NAME);
		try {
			return await buildIndexReport(this.app, this.settings, db);
		} finally {
			await db.close().catch(() => undefined);
		}
	}

	/** Files currently being transferred with chunk progress (for live highlighting). */
	getActiveTransfers(): { path: string; done: number; total: number }[] {
		return this.engine?.getActiveTransfers() ?? [];
	}

	/** Force (re)sync a single file. Starts a session first if none is running. */
	async forceSyncPath(path: string): Promise<void> {
		if (!this.engine) {
			await this.restartSync();
			return;
		}
		await this.engine.forceSync(path);
	}

	/** Remove a file/folder from the DB index (works even when idle). */
	async removeFromIndex(target: string, folder: boolean): Promise<number> {
		if (this.engine) return this.engine.removeFromIndex(target, folder);
		if (!this.settings.serverUrl) return 0;
		const db = new SyncDatabase(this.settings, LOCAL_DB_NAME);
		try {
			return await removeFromDb(db, target, folder);
		} finally {
			await db.close().catch(() => undefined);
		}
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		if (!this.settings.deviceId) {
			this.settings.deviceId = generateDeviceId();
			await this.saveSettings();
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
