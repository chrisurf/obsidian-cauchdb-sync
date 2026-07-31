import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type CouchDBSyncPlugin from "./main";
import { SyncDatabase } from "./database";
import { selfTest } from "./crypto";
import { IndexPanel } from "./indexpanel";

/**
 * The plugin's settings tab: the sync status panel at the top, then the settings
 * themselves. The panel is a shared component (see IndexPanel) — the same one the
 * right-sidebar view mounts — so the two can never drift apart.
 */
export class CouchDBSyncSettingTab extends PluginSettingTab {
	plugin: CouchDBSyncPlugin;
	private panel: IndexPanel;

	constructor(app: App, plugin: CouchDBSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		this.panel = new IndexPanel(plugin);
	}

	hide(): void {
		this.panel.unmount();
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		// The panel owns this host element entirely; the settings follow below it.
		this.panel.unmount();
		this.panel.mount(containerEl.createDiv({ cls: "couchdb-sync-panel-host" }));

		containerEl.createEl("h2", { text: "CouchDB connection" });

		// Any change to credentials voids the "connection verified" flag — otherwise
		// flipping the URL would not re-gate the index status view.
		const onCredsChanged = async () => {
			await this.plugin.invalidateConnection();
		};

		new Setting(containerEl)
			.setName("Server URL")
			.setDesc("Full URL incl. protocol and port. Must be https for mobile and for encryption in transit.")
			.addText((t) =>
				t
					.setPlaceholder("https://couch.example.com:6984")
					.setValue(s.serverUrl)
					.onChange(async (v) => {
						s.serverUrl = v.trim();
						await this.plugin.saveSettings();
						await onCredsChanged();
					})
			);

		new Setting(containerEl).setName("Database name").addText((t) =>
			t.setValue(s.dbName).onChange(async (v) => {
				s.dbName = v.trim();
				await this.plugin.saveSettings();
				await onCredsChanged();
			})
		);

		new Setting(containerEl).setName("Username").addText((t) =>
			t.setValue(s.username).onChange(async (v) => {
				s.username = v.trim();
				await this.plugin.saveSettings();
				await onCredsChanged();
			})
		);

		new Setting(containerEl).setName("Password").addText((t) => {
			t.inputEl.type = "password";
			t.setValue(s.password).onChange(async (v) => {
				s.password = v;
				await this.plugin.saveSettings();
				await onCredsChanged();
			});
		});

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Check the server URL, database and credentials. On success this also unlocks the Index status view (it stays hidden until you have proven the credentials).")
			.addButton((b) =>
				b.setButtonText("Test").onClick(async () => {
					const db = new SyncDatabase(s, "couchdb-sync-test-probe");
					const res = await db.testConnection();
					new Notice(res.message, res.ok ? 4000 : 8000);
					// The probe only needs the remote; destroy the throwaway local replica
					// instead of leaving an empty PouchDB behind on every Test click.
					await db.destroyLocal().catch(() => undefined);
					if (res.ok) {
						await this.plugin.markConnectionVerified();
						this.panel.refresh(); // the index view is unlocked now
					}
				})
			);

		containerEl.createEl("h2", { text: "Encryption" });

		new Setting(containerEl)
			.setName("End-to-end encryption")
			.setDesc("Encrypt note content AND metadata — file paths, sizes and timestamps — at rest on the server (AES-256-GCM). Recommended; on by default. Changing this setting or the passphrase changes the storage format and requires a local wipe + fresh re-sync.")
			.addToggle((t) =>
				t.setValue(s.e2eeEnabled).onChange(async (v) => {
					s.e2eeEnabled = v;
					await this.plugin.saveSettings();
					this.display();
				})
			);

		if (s.e2eeEnabled) {
			new Setting(containerEl)
				.setName("Passphrase")
				.setDesc("Shared secret. MUST be identical on every device. Never stored on the server.")
				.addText((t) => {
					t.inputEl.type = "password";
					t.setValue(s.passphrase).onChange(async (v) => {
						s.passphrase = v;
						await this.plugin.saveSettings();
					});
				})
				.addButton((b) =>
					b.setButtonText("Verify").onClick(async () => {
						if (!s.passphrase) return new Notice("Passphrase is empty.");
						const ok = await selfTest(s.passphrase).catch(() => false);
						new Notice(ok ? "Encryption works ✓" : "Encryption self-test failed.");
					})
				);
		}

		containerEl.createEl("h2", { text: "Conflict handling" });

		new Setting(containerEl)
			.setName("Conflict strategy")
			.setDesc("How conflicts are resolved automatically — no pop-ups, ever.")
			.addDropdown((d) =>
				d
					.addOption("newest", "Newest version wins")
					.addOption("master", "Master device wins")
					.setValue(s.conflictStrategy)
					.onChange(async (v) => {
						s.conflictStrategy = v as typeof s.conflictStrategy;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		if (s.conflictStrategy === "master") {
			new Setting(containerEl)
				.setName("This device is the master")
				.setDesc("On conflict, this device's version always wins. Set this on exactly one (e.g. your desktop).")
				.addToggle((t) =>
					t.setValue(s.isMaster).onChange(async (v) => {
						s.isMaster = v;
						await this.plugin.saveSettings();
					})
				);
		}

		containerEl.createEl("h2", { text: "Sync" });

		// NOTE: there is deliberately no "start automatically" toggle. The master
		// switch in the status card is the single source of truth: on means this
		// vault syncs (including on launch). See CouchDBSyncSettings.syncEnabled.

		new Setting(containerEl)
			.setName("Live sync (real-time)")
			.setDesc("Keep changes flowing continuously in both directions. Off = sync only when you press “Sync now”. Takes effect immediately.")
			.addToggle((t) =>
				t.setValue(s.liveSync).onChange(async (v) => {
					s.liveSync = v;
					await this.plugin.saveSettings();
					if (v) await this.plugin.restartSync(); // start live now
					else await this.plugin.stopSync(); // stop continuous sync now
				})
			);

		new Setting(containerEl)
			.setName("Sync hidden files")
			.setDesc(
				"Hidden files are things like .obsidian (your settings & plugins) and .git. " +
					"Normal notes & attachments are always synced. (Our own plugin's data.json is never synced.)"
			)
			.addToggle((t) =>
				t.setValue(s.syncHidden).onChange(async (v) => {
					s.syncHidden = v;
					await this.plugin.saveSettings();
					this.display(); // swap between the exclude / include field
				})
			);

		if (s.syncHidden) {
			// ON: blacklist — everything hidden syncs except these
			new Setting(containerEl)
				.setName("…except these")
				.setDesc("One path per line. These hidden files/folders are NOT synced. Everything else hidden is.")
				.addTextArea((t) => {
					t.setValue(s.hiddenExclude.join("\n")).onChange(async (v) => {
						s.hiddenExclude = v.split("\n").map((x) => x.trim()).filter((x) => x.length > 0);
						await this.plugin.saveSettings();
					});
					t.inputEl.rows = 8;
				});
		} else {
			// OFF: whitelist — nothing hidden syncs except these
			new Setting(containerEl)
				.setName("…but still sync these")
				.setDesc("One path per line. Hidden files are skipped — list any you DO want synced (e.g. .obsidian/snippets/). Leave empty to skip all hidden files.")
				.addTextArea((t) => {
					t.setValue(s.hiddenInclude.join("\n")).onChange(async (v) => {
						s.hiddenInclude = v.split("\n").map((x) => x.trim()).filter((x) => x.length > 0);
						await this.plugin.saveSettings();
					});
					t.inputEl.rows = 4;
				});
		}

		containerEl.createEl("h2", { text: "Actions" });

		// NOTE: "Sync now" and "Stop" are deliberately NOT repeated here — they live
		// in the status card, next to the state they act on. Only actions that are
		// not part of the everyday loop remain in this section.

		new Setting(containerEl)
			.setName("Download from server")
			.setDesc(
				"Pull the server's state to this device WITHOUT uploading local changes, then " +
					"materialize anything that is in the local index but missing on disk. " +
					"Useful on a follower device, after a Google Drive desync, or to force the master's state."
			)
			.addButton((b) =>
				b.setButtonText("Download only").onClick(async () => {
					new Notice("Downloading from server…");
					await this.plugin.downloadFromServer();
				})
			);

		new Setting(containerEl)
			.setName("Wipe local cache")
			.setDesc("Delete this device's local copy only — fast, and the server is NOT touched. Afterwards press “Sync now” or “Download only” to rebuild it.")
			.addButton((b) =>
				b
					.setWarning()
					.setButtonText("Wipe local cache")
					.onClick(async () => {
						await this.plugin.wipeLocalOnly();
						new Notice("Local cache wiped. Press “Sync now” or “Download only” to rebuild.");
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("Forget local cache when plugin is disabled")
			.setDesc(
				"Privacy mode. When you disable or uninstall the plugin, the local PouchDB " +
					"is destroyed. The local cache always keeps some cleartext metadata on this " +
					"device — the per-file sync-state index holds vault paths, sizes and hashes " +
					"even with E2EE on (E2EE protects what reaches the server, not the local " +
					"cache). Trade-off: re-enabling forces a full re-download from the server. " +
					"Off by default."
			)
			.addToggle((t) =>
				t.setValue(s.forgetCacheOnDisable).onChange(async (v) => {
					s.forgetCacheOnDisable = v;
					await this.plugin.saveSettings();
				})
			);

		// Legacy cleanup: before vault isolation, every vault on the machine shared
		// one global PouchDB named "couchdb-sync-local". Offer to delete it so the
		// data from old vaults stops leaking into the index status.
		void this.plugin.legacyLocalDbDocCount().then((n) => {
			if (n <= 0) return;
			new Setting(containerEl)
				.setName("Wipe legacy shared cache")
				.setDesc(
					`A pre-vault-isolation local cache with ${n} document(s) was found. It is shared across ALL vaults on this machine and may show files from other vaults in the index. Safe to delete — the server is not touched.`
				)
				.addButton((b) =>
					b
						.setWarning()
						.setButtonText("Wipe legacy cache")
						.onClick(async () => {
							await this.plugin.wipeLegacyLocalDb();
							new Notice("Legacy shared cache wiped.");
							this.display();
						})
				);
		});

		containerEl.createEl("p", {
			text: `Device ID: ${s.deviceId || "(not yet assigned)"}  ·  Local DB id: ${s.localDbId || "(not yet assigned)"}`,
			cls: "setting-item-description",
		});
	}
}
