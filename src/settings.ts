import { App, Modal, PluginSettingTab, Setting, Notice } from "obsidian";
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

		this.renderIndexStatus(containerEl);

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

		new Setting(containerEl)
			.setName("Reset local database")
			.setDesc(
				"Wipe this device's local cache and re-download everything from the server. " +
					"Safe: the server data is not touched. Use this if the local index is inconsistent."
			)
			.addButton((b) =>
				b
					.setWarning()
					.setButtonText("Reset & re-download")
					.onClick(async () => {
						new Notice("Resetting local database…");
						await this.plugin.resetLocalDatabase();
						new Notice("Local database reset; re-downloading from server.");
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("Wipe server database")
			.setDesc(
				"DELETE the entire database on the server, then re-upload this device's vault " +
					"from scratch. Destructive — other devices' data on the server is removed " +
					"(they will re-upload on their next sync). Use this to start completely fresh."
			)
			.addButton((b) =>
				b
					.setWarning()
					.setButtonText("Wipe server & re-upload")
					.onClick(() => {
						new ConfirmModal(
							this.app,
							"Wipe server database?",
							`This permanently deletes ALL data in the server database "${s.dbName}" ` +
								`and re-uploads this device's vault. This cannot be undone. Continue?`,
							"Wipe & re-upload",
							async () => {
								new Notice("Wiping server database…");
								await this.plugin.wipeRemoteAndReset();
								new Notice("Server wiped; re-uploading from this device.");
								this.display();
							}
						).open();
					})
			);

		containerEl.createEl("p", {
			text: `Device ID: ${s.deviceId || "(not yet assigned)"}`,
			cls: "setting-item-description",
		});
	}

	// --- index status view -------------------------------------------------

	private renderIndexStatus(root: HTMLElement): void {
		new Setting(root)
			.setHeading()
			.setName("Index status")
			.addButton((b) =>
				b.setButtonText("Refresh").onClick(() => this.loadIndex(box))
			);
		const box = root.createDiv({ cls: "couchdb-sync-index" });
		box.createEl("p", { text: "Loading…", cls: "setting-item-description" });
		void this.loadIndex(box);
	}

	private async loadIndex(box: HTMLElement): Promise<void> {
		box.empty();
		let report;
		try {
			report = await this.plugin.getIndexReport();
		} catch (e) {
			box.createEl("p", {
				text: `Could not read index: ${e instanceof Error ? e.message : String(e)}`,
				cls: "couchdb-sync-warn",
			});
			return;
		}
		if (!report) {
			box.createEl("p", {
				text: "Sync is not running. Configure the connection (and passphrase) and restart sync.",
				cls: "setting-item-description",
			});
			return;
		}

		const drifted = report.localOnly.length + report.dbOnly.length + report.drift.length;
		const summary = box.createDiv({
			cls: drifted === 0 ? "couchdb-sync-ok" : "couchdb-sync-warn",
		});
		summary.createSpan({
			text:
				drifted === 0
					? `✓ In sync — ${report.inSync.length} files`
					: `⚠ Drift — ${drifted} file(s) differ`,
			cls: "couchdb-sync-summary",
		});
		box.createEl("p", {
			text: `This device: ${report.vaultCount} files · Database: ${report.dbCount} files`,
			cls: "setting-item-description",
		});

		if (drifted > 0) {
			this.renderDriftList(box, "Only on this device (not yet uploaded)", report.localOnly);
			this.renderDriftList(box, "Only in database (not yet downloaded here)", report.dbOnly);
			this.renderDriftList(box, "Content differs (will be resolved by your conflict strategy)", report.drift);
		}

		const tree = box.createEl("details", { cls: "couchdb-sync-tree-root" });
		tree.createEl("summary", { text: `📂 File tree — ${report.allDbPaths.length} indexed files` });
		this.renderTree(tree.createDiv({ cls: "couchdb-sync-tree" }), report.allDbPaths);
	}

	private renderDriftList(box: HTMLElement, title: string, paths: string[]): void {
		if (paths.length === 0) return;
		const det = box.createEl("details", { cls: "couchdb-sync-drift" });
		det.createEl("summary", { text: `${title} (${paths.length})` });
		const ul = det.createEl("ul");
		for (const p of paths) ul.createEl("li", { text: p });
	}

	private renderTree(container: HTMLElement, paths: string[]): void {
		interface Node {
			folders: Map<string, Node>;
			files: string[];
		}
		const make = (): Node => ({ folders: new Map(), files: [] });
		const rootNode = make();
		for (const path of paths) {
			const parts = path.split("/");
			let node = rootNode;
			for (let i = 0; i < parts.length - 1; i++) {
				const name = parts[i];
				if (!node.folders.has(name)) node.folders.set(name, make());
				node = node.folders.get(name)!;
			}
			node.files.push(parts[parts.length - 1]);
		}

		const render = (node: Node, el: HTMLElement) => {
			const folderNames = [...node.folders.keys()].sort((a, b) => a.localeCompare(b));
			for (const name of folderNames) {
				const child = node.folders.get(name)!;
				const det = el.createEl("details");
				det.createEl("summary", { text: `📁 ${name}` });
				render(child, det.createDiv({ cls: "couchdb-sync-tree-children" }));
			}
			for (const file of node.files.sort((a, b) => a.localeCompare(b))) {
				el.createDiv({ cls: "couchdb-sync-tree-file", text: `📄 ${file}` });
			}
		};
		render(rootNode, container);
	}
}

/** Minimal confirmation dialog for destructive actions. */
class ConfirmModal extends Modal {
	private title: string;
	private body: string;
	private confirmLabel: string;
	private onConfirm: () => void | Promise<void>;

	constructor(
		app: App,
		title: string,
		body: string,
		confirmLabel: string,
		onConfirm: () => void | Promise<void>
	) {
		super(app);
		this.title = title;
		this.body = body;
		this.confirmLabel = confirmLabel;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.title });
		contentEl.createEl("p", { text: this.body });
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setWarning()
					.setButtonText(this.confirmLabel)
					.onClick(async () => {
						this.close();
						await this.onConfirm();
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
