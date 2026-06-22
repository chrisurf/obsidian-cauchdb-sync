import { Notice, Plugin } from "obsidian";
import { CouchDBSyncSettings, DEFAULT_SETTINGS, SYNC_STATE, SyncState } from "./types";
import { SyncDatabase } from "./database";
import { SyncEngine } from "./engine";
import { CouchDBSyncSettingTab } from "./settings";
import { generateDeviceId } from "./util";

const LOCAL_DB_NAME = "couchdb-sync-local";

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

		// Start after the layout is ready so the initial scan sees a settled vault.
		this.app.workspace.onLayoutReady(() => void this.restartSync());
	}

	async onunload(): Promise<void> {
		this.engine?.stop();
		await this.db?.close().catch(() => undefined);
		this.engine = null;
		this.db = null;
	}

	private setStatus(state: SyncState, detail?: string): void {
		this.statusEl.setText(`CouchDB ${STATUS_ICON[state]}`);
		this.statusEl.setAttr("aria-label", detail ? `${state}: ${detail}` : `CouchDB sync: ${state}`);
		if (state === SYNC_STATE.ERROR && detail) {
			console.error("[couchdb-sync]", detail);
		}
	}

	async restartSync(): Promise<void> {
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

		this.db = new SyncDatabase(this.settings, LOCAL_DB_NAME);
		this.engine = new SyncEngine(this.app, this.db, this.settings, (s, d) => this.setStatus(s, d));
		try {
			await this.engine.start();
		} catch (e) {
			this.setStatus(SYNC_STATE.ERROR, String(e));
			new Notice(`CouchDB Sync failed to start: ${e}`);
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
