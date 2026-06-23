import { Notice, Plugin } from "obsidian";
import { CouchDBSyncSettings, DEFAULT_SETTINGS, SYNC_STATE, SyncState } from "./types";
import { SyncDatabase } from "./database";
import { SyncEngine, IndexReport } from "./engine";
import { CouchDBSyncSettingTab } from "./settings";
import { generateDeviceId } from "./util";

// bumped to v2: file docs are now keyed "f:" + path; start from a clean local store
const LOCAL_DB_NAME = "couchdb-sync-local-v2";

const STATUS_ICON: Record<SyncState, string> = {
	[SYNC_STATE.IDLE]: "⏸",
	[SYNC_STATE.CONNECTING]: "🔌",
	[SYNC_STATE.SYNCING]: "🔄",
	[SYNC_STATE.SYNCED]: "✅",
	[SYNC_STATE.OFFLINE]: "📴",
	[SYNC_STATE.PAUSED]: "⏸",
	[SYNC_STATE.ERROR]: "⚠️",
};

export default class CouchDBSyncPlugin extends Plugin {
	settings!: CouchDBSyncSettings;
	private db: SyncDatabase | null = null;
	private engine: SyncEngine | null = null;
	private statusEl!: HTMLElement;
	private restartLock: Promise<void> = Promise.resolve();

	async onload(): Promise<void> {
		await this.loadSettings();

		this.statusEl = this.addStatusBarItem();
		this.statusEl.setText("CouchDB: idle");

		this.addSettingTab(new CouchDBSyncSettingTab(this.app, this));

		this.addCommand({
			id: "couchdb-sync-now",
			name: "Sync now",
			callback: async () => {
				if (!this.engine) await this.restartSync();
				else await this.engine.replicateOnce();
			},
		});

		this.addCommand({
			id: "couchdb-sync-restart",
			name: "Restart sync",
			callback: () => this.restartSync(),
		});

		this.addCommand({
			id: "couchdb-sync-reset-local",
			name: "Reset local database (re-download from server)",
			callback: async () => {
				new Notice("CouchDB Sync: resetting local database…");
				await this.resetLocalDatabase();
				new Notice("CouchDB Sync: local database reset; re-downloading.");
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

	private setStatus(state: SyncState, detail?: string): void {
		this.statusEl.setText(`CouchDB ${STATUS_ICON[state]}`);
		this.statusEl.setAttr("aria-label", detail ? `${state}: ${detail}` : `CouchDB sync: ${state}`);
		if (state === SYNC_STATE.ERROR && detail) {
			console.error("[couchdb-sync]", detail);
		}
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
			.then(() => this.doRestart());
		return this.restartLock;
	}

	private async doRestart(): Promise<void> {
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
			await engine.start();
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
	 * Wipe the LOCAL replica and re-download everything from the server. This only
	 * affects this device's cache (the remote data is untouched), so it is a safe
	 * recovery action. Serialized through the same lock as restartSync.
	 */
	resetLocalDatabase(): Promise<void> {
		this.engine?.abort();
		this.restartLock = this.restartLock
			.catch(() => undefined)
			.then(async () => {
				this.engine?.stop();
				const db = this.db ?? new SyncDatabase(this.settings, LOCAL_DB_NAME);
				await db.destroyLocal().catch(() => undefined);
				this.engine = null;
				this.db = null;
				await this.doRestart();
			});
		return this.restartLock;
	}

	/** Whether a sync session is currently active. */
	isRunning(): boolean {
		return this.engine !== null;
	}

	/** Index/drift report for the settings view, or null if sync isn't running. */
	async getIndexReport(): Promise<IndexReport | null> {
		if (!this.engine) return null;
		return this.engine.getIndexReport();
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
