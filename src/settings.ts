import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type CouchDBSyncPlugin from "./main";
import { SyncDatabase } from "./database";
import { selfTest } from "./crypto";

export class CouchDBSyncSettingTab extends PluginSettingTab {
	plugin: CouchDBSyncPlugin;

	constructor(app: App, plugin: CouchDBSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		containerEl.createEl("h2", { text: "CouchDB connection" });

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
					})
			);

		new Setting(containerEl).setName("Database name").addText((t) =>
			t.setValue(s.dbName).onChange(async (v) => {
				s.dbName = v.trim();
				await this.plugin.saveSettings();
			})
		);

		new Setting(containerEl).setName("Username").addText((t) =>
			t.setValue(s.username).onChange(async (v) => {
				s.username = v.trim();
				await this.plugin.saveSettings();
			})
		);

		new Setting(containerEl).setName("Password").addText((t) => {
			t.inputEl.type = "password";
			t.setValue(s.password).onChange(async (v) => {
				s.password = v;
				await this.plugin.saveSettings();
			});
		});

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Check the server URL, database and credentials.")
			.addButton((b) =>
				b.setButtonText("Test").onClick(async () => {
					const db = new SyncDatabase(s, "couchdb-sync-test-probe");
					const res = await db.testConnection();
					new Notice(res.message, res.ok ? 4000 : 8000);
					await db.close();
				})
			);

		containerEl.createEl("h2", { text: "Encryption" });

		new Setting(containerEl)
			.setName("End-to-end encryption")
			.setDesc("Encrypt note content at rest on the server (AES-256-GCM). Recommended; on by default.")
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

		new Setting(containerEl)
			.setName("Live sync")
			.setDesc("Continuously sync in real time. Turn off to sync only on command.")
			.addToggle((t) =>
				t.setValue(s.liveSync).onChange(async (v) => {
					s.liveSync = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Ignore patterns")
			.setDesc("One per line. Path prefixes that are never synced.")
			.addTextArea((t) =>
				t.setValue(s.ignorePatterns.join("\n")).onChange(async (v) => {
					s.ignorePatterns = v
						.split("\n")
						.map((x) => x.trim())
						.filter((x) => x.length > 0);
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Apply & restart sync")
			.setDesc("Restart synchronization with the current settings.")
			.addButton((b) =>
				b
					.setCta()
					.setButtonText("Restart sync")
					.onClick(async () => {
						await this.plugin.restartSync();
						new Notice("Sync restarted.");
					})
			);

		containerEl.createEl("p", {
			text: `Device ID: ${s.deviceId || "(not yet assigned)"}`,
			cls: "setting-item-description",
		});
	}
}
