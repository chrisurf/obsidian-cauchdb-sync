import { App, Notice, PluginSettingTab, Setting, type SettingDefinitionItem, type SettingDefinitionRender } from "obsidian";
import type CouchDBSyncPlugin from "./main";
import { SyncDatabase } from "./database";
import { selfTest } from "./crypto";
import { IndexPanel } from "./indexpanel";

/**
 * The plugin's settings tab: the sync status panel at the top, then the settings
 * themselves. The panel is a shared component (see IndexPanel) — the same one the
 * right-sidebar view mounts — so the two can never drift apart.
 *
 * Built with Obsidian 1.13's declarative settings API (`getSettingDefinitions`)
 * rather than the deprecated imperative `display()`, so the settings are indexed
 * by name/description in Obsidian's global settings search. Rows whose control is
 * more than a plain bind (the credential fields with their live "connection
 * verified" reset, the encryption self-test, the async legacy-cache cleanup, and
 * the custom status panel) use the API's `render` escape hatch, which keeps their
 * exact behaviour while still contributing their name/description to search.
 * Reactive show/hide (passphrase, master toggle, hidden-file lists) is expressed
 * with `visible` predicates and refreshed via `this.update()`.
 */
export class CouchDBSyncSettingTab extends PluginSettingTab {
	plugin: CouchDBSyncPlugin;
	private panel: IndexPanel;
	/** Cached legacy-cache doc count; probed once, then drives the legacy-wipe row. */
	private legacyCount = 0;
	private legacyProbed = false;

	constructor(app: App, plugin: CouchDBSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		// Settings shows the high-level card only (status + store widgets); the full
		// detail (attention list + the three store trees) lives in the sidebar panel.
		this.panel = new IndexPanel(plugin, "compact");
	}

	hide(): void {
		this.panel.unmount();
	}

	/**
	 * Add a show/hide toggle (an eye icon) to a masked text field. The field stays
	 * masked by default; clicking flips its input between `password` and plain `text`
	 * and swaps the icon (eye ⇄ eye-off). `getInput` is read lazily so it resolves the
	 * element the `addText` callback captured. A fresh render always starts masked, so
	 * a revealed value never persists across re-renders.
	 */
	private addRevealButton(setting: Setting, getInput: () => HTMLInputElement | undefined): void {
		let shown = false;
		setting.addExtraButton((b) =>
			b
				.setIcon("eye")
				.setTooltip("Show")
				.onClick(() => {
					const input = getInput();
					if (!input) return;
					shown = !shown;
					input.type = shown ? "text" : "password";
					b.setIcon(shown ? "eye-off" : "eye").setTooltip(shown ? "Hide" : "Show");
				})
		);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const s = this.plugin.settings;
		// The configuration folder is ".obsidian" by default but can be renamed, so
		// the examples in the hidden-file settings name this vault's actual folder.
		const cfg = this.app.vault.configDir;

		// Probe the legacy shared cache once (async); reveal its cleanup row via
		// update() only if it actually exists.
		if (!this.legacyProbed) {
			this.legacyProbed = true;
			void this.plugin.legacyLocalDbDocCount().then((n) => {
				if (n > 0) {
					this.legacyCount = n;
					this.update();
				}
			});
		}

		// Any change to credentials voids the "connection verified" flag — otherwise
		// flipping the URL would not re-gate the index status view.
		const onCredsChanged = () => this.plugin.invalidateConnection();

		/**
		 * A row that renders imperatively but still contributes to settings search.
		 * `build` mirrors Obsidian's own `addText`/`addToggle` callbacks (`=> any`):
		 * it returns the chainable component/Setting, which we discard — typing it as
		 * `unknown` (not `void`) is what keeps that a plain builder rather than a
		 * "void-returning" slot that no-misused-promises would police.
		 */
		const row = (
			name: string,
			desc: string | undefined,
			build: (setting: Setting) => unknown,
			extra?: Partial<SettingDefinitionRender>
		): SettingDefinitionRender => ({
			name,
			desc,
			...extra,
			render: (setting) => {
				setting.setName(name);
				if (desc) setting.setDesc(desc);
				build(setting);
			},
		});

		return [
			// --- status panel (custom UI; owns its row entirely) ---
			{
				name: "Sync status",
				searchable: false,
				render: (setting) => {
					const el = setting.settingEl;
					el.empty();
					el.removeClass("setting-item");
					el.addClass("couchdb-sync-panel-host");
					this.panel.unmount();
					this.panel.mount(el);
					return () => this.panel.unmount();
				},
			},

			// --- CouchDB connection ---
			{
				type: "group",
				heading: "CouchDB connection",
				items: [
					row("Server URL", "Full URL incl. protocol and port. Must be https for mobile and for encryption in transit.", (setting) =>
						setting.addText((t) =>
							t
								.setPlaceholder("https://couch.example.com:6984")
								.setValue(s.serverUrl)
								.onChange(async (v) => {
									s.serverUrl = v.trim();
									await this.plugin.saveSettings();
									await onCredsChanged();
								})
						)
					),
					row("Database name", undefined, (setting) =>
						setting.addText((t) =>
							t.setValue(s.dbName).onChange(async (v) => {
								s.dbName = v.trim();
								await this.plugin.saveSettings();
								await onCredsChanged();
							})
						)
					),
					row("Username", undefined, (setting) =>
						setting.addText((t) =>
							t.setValue(s.username).onChange(async (v) => {
								s.username = v.trim();
								await this.plugin.saveSettings();
								await onCredsChanged();
							})
						)
					),
					row("Password", undefined, (setting) => {
						let input: HTMLInputElement | undefined;
						setting.addText((t) => {
							input = t.inputEl;
							t.inputEl.type = "password"; // masked by default
							t.setValue(s.password).onChange(async (v) => {
								s.password = v;
								await this.plugin.saveSettings();
								await onCredsChanged();
							});
						});
						this.addRevealButton(setting, () => input);
					}),
					row(
						"Test connection",
						"Check the server URL, database and credentials. On success this also unlocks the Index status view (it stays hidden until you have proven the credentials).",
						(setting) =>
							setting.addButton((b) =>
								b.setButtonText("Test").onClick(async () => {
									const db = new SyncDatabase(s, "couchdb-sync-test-probe");
									const res = await db.testConnection();
									new Notice(res.message, res.ok ? 4000 : 8000);
									// The probe only needs the remote; destroy the throwaway local
									// replica instead of leaving an empty PouchDB behind.
									await db.destroyLocal().catch(() => undefined);
									if (res.ok) {
										await this.plugin.markConnectionVerified();
										this.panel.refresh(); // the index view is unlocked now
									}
								})
							)
					),
				],
			},

			// --- Encryption ---
			{
				type: "group",
				heading: "Encryption",
				items: [
					// Encryption is mandatory — there is deliberately no on/off toggle. The
					// passphrase row is the single place that explains and controls it.
					row(
						"Encryption passphrase",
						"Your notes are always end-to-end encrypted (AES-256-GCM). Use the same passphrase on every device — it's the only key to your notes, never leaves your device, and can't be recovered if you lose it.",
						(setting) => {
							let input: HTMLInputElement | undefined;
							setting.addText((t) => {
								input = t.inputEl;
								t.inputEl.type = "password"; // masked by default
								t.setValue(s.passphrase).onChange(async (v) => {
									s.passphrase = v;
									await this.plugin.saveSettings();
								});
							});
							this.addRevealButton(setting, () => input);
							setting.addButton((b) =>
								b.setButtonText("Verify").onClick(async () => {
									if (!s.passphrase) {
										new Notice("Passphrase is empty.");
										return;
									}
									const ok = await selfTest(s.passphrase).catch(() => false);
									new Notice(ok ? "Encryption works ✓" : "Encryption self-test failed.");
								})
							);
						}
					),
				],
			},

			// --- Conflict handling ---
			{
				type: "group",
				heading: "Conflict handling",
				items: [
					row("Conflict strategy", "How conflicts are resolved automatically — no pop-ups, ever.", (setting) =>
						setting.addDropdown((d) =>
							d
								.addOption("newest", "Newest version wins")
								.addOption("master", "Master device wins")
								.setValue(s.conflictStrategy)
								.onChange(async (v) => {
									s.conflictStrategy = v as typeof s.conflictStrategy;
									await this.plugin.saveSettings();
									this.update(); // show/hide the master-device row
								})
						)
					),
					row(
						"This device is the master",
						"On conflict, this device's version always wins. Set this on exactly one (e.g. your desktop).",
						(setting) =>
							setting.addToggle((t) =>
								t.setValue(s.isMaster).onChange(async (v) => {
									s.isMaster = v;
									await this.plugin.saveSettings();
								})
							),
						{ visible: () => this.plugin.settings.conflictStrategy === "master" }
					),
				],
			},

			// --- Sync ---
			// NOTE: there is deliberately no "start automatically" toggle. The master
			// switch in the status card is the single source of truth: on means this
			// vault syncs (including on launch). See CouchDBSyncSettings.syncEnabled.
			{
				type: "group",
				heading: "Sync",
				items: [
					// Live sync (real-time, both directions) is always on — there is no toggle
					// to turn it off. Use the master Sync switch to stop syncing entirely.
					row(
						"Sync hidden files",
						`Hidden files are things like ${cfg} (your settings & plugins) and .git. ` +
							"Normal notes & attachments are always synced. (Our own plugin's data.json is never synced.)",
						(setting) =>
							setting.addToggle((t) =>
								t.setValue(s.syncHidden).onChange(async (v) => {
									s.syncHidden = v;
									await this.plugin.saveSettings();
									this.update(); // swap between the exclude / include list
								})
							)
					),
					// ON: blacklist — everything hidden syncs except these
					row(
						"…except these",
						"One path per line. These hidden files/folders are NOT synced. Everything else hidden is.",
						(setting) =>
							setting.addTextArea((t) => {
								t.setValue(s.hiddenExclude.join("\n")).onChange(async (v) => {
									s.hiddenExclude = v.split("\n").map((x) => x.trim()).filter((x) => x.length > 0);
									await this.plugin.saveSettings();
								});
								t.inputEl.rows = 8;
							}),
						{ visible: () => this.plugin.settings.syncHidden }
					),
					// OFF: whitelist — nothing hidden syncs except these
					row(
						"…but still sync these",
						"One path per line. Hidden files are skipped — list any you DO want synced " +
							`(e.g. ${cfg}/snippets/). Leave empty to skip all hidden files.`,
						(setting) =>
							setting.addTextArea((t) => {
								t.setValue(s.hiddenInclude.join("\n")).onChange(async (v) => {
									s.hiddenInclude = v.split("\n").map((x) => x.trim()).filter((x) => x.length > 0);
									await this.plugin.saveSettings();
								});
								t.inputEl.rows = 4;
							}),
						{ visible: () => !this.plugin.settings.syncHidden }
					),
				],
			},

			// --- Actions ---
			// NOTE: "Force sync" is deliberately NOT repeated here — it lives in the
			// status card, next to the state it acts on. Only actions that are not part
			// of the everyday loop remain in this section.
			{
				type: "group",
				heading: "Actions",
				items: [
					row(
						"Download from server",
						"Pull the server's state to this device WITHOUT uploading local changes, then " +
							"materialize anything that is in the local index but missing on disk. " +
							"Useful on a follower device, after a Google Drive desync, or to force the master's state.",
						(setting) =>
							setting.addButton((b) =>
								b.setButtonText("Download only").onClick(async () => {
									new Notice("Downloading from server…");
									await this.plugin.downloadFromServer();
								})
							)
					),
					row(
						"Wipe local cache",
						"Delete this device's local copy only — fast, and the server is NOT touched. Afterwards press “Force sync” or “Download only” to rebuild it.",
						(setting) =>
							setting.addButton((b) =>
								b
									.setDestructive()
									.setButtonText("Wipe local cache")
									.onClick(async () => {
										await this.plugin.wipeLocalOnly();
										new Notice("Local cache wiped. Press “Force sync” or “Download only” to rebuild.");
										this.update();
									})
							)
					),
					row(
						"Forget local cache when plugin is disabled",
						"Privacy mode. When you disable or uninstall the plugin, the local PouchDB " +
							"is destroyed. The local cache always keeps some cleartext metadata on this " +
							"device — the per-file sync-state index holds vault paths, sizes and hashes " +
							"even with E2EE on (E2EE protects what reaches the server, not the local " +
							"cache). Trade-off: re-enabling forces a full re-download from the server. " +
							"Off by default.",
						(setting) =>
							setting.addToggle((t) =>
								t.setValue(s.forgetCacheOnDisable).onChange(async (v) => {
									s.forgetCacheOnDisable = v;
									await this.plugin.saveSettings();
								})
							)
					),
					// Legacy cleanup: before vault isolation, every vault on the machine
					// shared one global PouchDB. Offer to delete it so old-vault data stops
					// leaking into the index status. Only shown once the probe finds it.
					row(
						"Wipe legacy shared cache",
						"A pre-vault-isolation local cache was found. It is shared across ALL vaults on this machine and may show files from other vaults in the index. Safe to delete — the server is not touched.",
						(setting) => {
							setting.setDesc(
								`A pre-vault-isolation local cache with ${this.legacyCount} document(s) was found. It is shared across ALL vaults on this machine and may show files from other vaults in the index. Safe to delete — the server is not touched.`
							);
							setting.addButton((b) =>
								b
									.setDestructive()
									.setButtonText("Wipe legacy cache")
									.onClick(async () => {
										await this.plugin.wipeLegacyLocalDb();
										this.legacyCount = 0;
										new Notice("Legacy shared cache wiped.");
										this.update();
									})
							);
						},
						{ visible: () => this.legacyCount > 0 }
					),
					{
						name: "Device identifiers",
						searchable: false,
						render: (setting) => {
							setting.settingEl.empty();
							setting.settingEl.addClass("setting-item-description");
							setting.settingEl.setText(
								`Device ID: ${s.deviceId || "(not yet assigned)"}  ·  Local DB id: ${s.localDbId || "(not yet assigned)"}`
							);
						},
					},
				],
			},
		];
	}
}
