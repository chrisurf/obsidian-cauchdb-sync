import { App, PluginSettingTab, Setting, Notice, setIcon } from "obsidian";
import type CouchDBSyncPlugin from "./main";
import { SyncDatabase } from "./database";
import { selfTest } from "./crypto";
import { SYNC_STATE, SyncStatus } from "./types";

const AUTO_REFRESH_MS = 3_000;

export class CouchDBSyncSettingTab extends PluginSettingTab {
	plugin: CouchDBSyncPlugin;
	private statusUnsub?: () => void;
	private autoRefresh?: number;
	private activeTimer?: number;
	private liveStatusEl?: HTMLElement;
	// persistent index-status elements (updated in place to avoid flicker)
	private summaryEl?: HTMLElement;
	private countsEl?: HTMLElement;
	private driftEl?: HTMLElement;
	private treeEl?: HTMLElement;
	private driftSig = "";
	private treeSig = "";

	constructor(app: App, plugin: CouchDBSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	hide(): void {
		this.statusUnsub?.();
		this.statusUnsub = undefined;
		if (this.autoRefresh !== undefined) {
			window.clearInterval(this.autoRefresh);
			this.autoRefresh = undefined;
		}
		if (this.activeTimer !== undefined) {
			window.clearInterval(this.activeTimer);
			this.activeTimer = undefined;
		}
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
			.setName("Start automatically on launch")
			.setDesc("When Obsidian opens, begin syncing on its own. Off = stay idle until you press “Sync now”.")
			.addToggle((t) =>
				t.setValue(s.autoStart).onChange(async (v) => {
					s.autoStart = v;
					await this.plugin.saveSettings();
				})
			);

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

		new Setting(containerEl)
			.setName("Sync now")
			.setDesc(
				"Connect and synchronize both ways — upload local changes AND pull server changes. " +
					"Also writes any cached-but-missing files from the local index to disk " +
					"(heals 'Only in database' entries). With Live sync on, this also (re)starts continuous sync."
			)
			.addButton((b) =>
				b
					.setCta()
					.setButtonText("Sync now")
					.onClick(async () => {
						new Notice("Syncing…");
						await this.plugin.restartSync();
					})
			);

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
			.setName("Stop sync")
			.setDesc("Stop syncing and go idle. Also turns off Live sync and auto-start so nothing resumes on its own.")
			.addButton((b) =>
				b.setButtonText("Stop").onClick(async () => {
					await this.plugin.stopSync();
					new Notice("Sync stopped. Live sync and auto-start turned off.");
					this.display(); // reflect the toggles being switched off
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

		containerEl.createEl("p", {
			text: `Device ID: ${s.deviceId || "(not yet assigned)"}`,
			cls: "setting-item-description",
		});
	}

	// --- index status view -------------------------------------------------

	private renderIndexStatus(root: HTMLElement): void {
		new Setting(root).setHeading().setName("Index status");

		// live status line (updates instantly from the engine)
		this.liveStatusEl = root.createDiv({ cls: "couchdb-sync-livestatus" });
		this.statusUnsub?.();
		this.statusUnsub = this.plugin.onStatusChange((st) => this.renderLiveStatus(st));

		// build the index box ONCE; later refreshes update these in place (no flicker)
		const box = root.createDiv({ cls: "couchdb-sync-index" });
		this.summaryEl = box.createDiv();
		this.countsEl = box.createEl("p", { cls: "setting-item-description" });
		this.driftEl = box.createDiv();
		this.treeEl = box.createDiv();
		this.driftSig = "";
		this.treeSig = "";
		this.summaryEl.setText("Loading…");

		void this.loadIndex(true);

		// auto-refresh the counts/lists in place (no flicker, no full page reload)
		if (this.autoRefresh !== undefined) window.clearInterval(this.autoRefresh);
		this.autoRefresh = window.setInterval(() => void this.loadIndex(false), AUTO_REFRESH_MS);

		// fast loop: highlight the files currently being worked on ("scanning" effect)
		if (this.activeTimer !== undefined) window.clearInterval(this.activeTimer);
		this.activeTimer = window.setInterval(() => this.highlightActive(), 600);
	}

	/** Highlight rows being worked on and show live chunk progress (done/total · %). */
	private highlightActive(): void {
		const transfers = new Map(
			this.plugin.getActiveTransfers().map((t) => [t.path, t] as const)
		);
		const root = this.driftEl?.parentElement;
		if (!root) return;
		root.querySelectorAll<HTMLElement>("[data-couchdb-path]").forEach((el) => {
			const t = transfers.get(el.dataset.couchdbPath ?? "");
			el.toggleClass("couchdb-sync-active", !!t);
			let prog = el.querySelector<HTMLElement>(".couchdb-sync-prog");
			if (t) {
				if (!prog) prog = el.createSpan({ cls: "couchdb-sync-prog" });
				const pct = t.total ? Math.round((t.done / t.total) * 100) : 0;
				prog.setText(`  ${t.done}/${t.total} chunks · ${pct}%`);
			} else if (prog) {
				prog.remove();
			}
		});
	}

	private renderLiveStatus(st: SyncStatus): void {
		const el = this.liveStatusEl;
		if (!el) return;
		el.empty();

		const syncing = st.state === SYNC_STATE.SYNCING;
		const row = el.createDiv({ cls: "couchdb-sync-livestatus-row" });
		const icon = row.createSpan({ cls: "couchdb-sync-status-icon" });
		setIcon(icon, syncing ? "refresh-cw" : st.state === SYNC_STATE.ERROR ? "alert-triangle" : "check");
		icon.toggleClass("couchdb-sync-spin", syncing);

		const labelMap: Record<string, string> = {
			[SYNC_STATE.IDLE]: "Idle",
			[SYNC_STATE.CONNECTING]: "Connecting…",
			[SYNC_STATE.SYNCING]: "Syncing…",
			[SYNC_STATE.SYNCED]: "In sync",
			[SYNC_STATE.OFFLINE]: "Offline",
			[SYNC_STATE.PAUSED]: "Paused",
			[SYNC_STATE.ERROR]: "Error",
		};
		row.createSpan({ text: labelMap[st.state] ?? st.state, cls: "couchdb-sync-livestatus-label" });

		if (syncing && st.total && st.total > 0) {
			const pct = Math.round((st.done! / st.total) * 100);
			row.createSpan({ text: ` ${pct}% (${st.done}/${st.total})`, cls: "setting-item-description" });
			const bar = el.createEl("progress");
			bar.max = st.total;
			bar.value = st.done ?? 0;
			bar.addClass("couchdb-sync-progress");
		} else if (st.detail && st.state === SYNC_STATE.ERROR) {
			el.createEl("p", { text: st.detail, cls: "couchdb-sync-warn" });
		}
	}

	/**
	 * Update the index status. Summary + counts are updated in place every time
	 * (cheap, no flicker). The drift lists and the file tree are only rebuilt when
	 * their contents actually change (or when force=true via the Refresh button),
	 * so the page doesn't flicker and an expanded tree stays expanded.
	 */
	private async loadIndex(force: boolean): Promise<void> {
		const summary = this.summaryEl;
		const counts = this.countsEl;
		const driftBox = this.driftEl;
		const treeBox = this.treeEl;
		if (!summary || !counts || !driftBox || !treeBox) return;

		let report;
		try {
			report = await this.plugin.getIndexReport();
		} catch (e) {
			summary.className = "couchdb-sync-warn";
			summary.setText(`Could not read index: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		if (!report) {
			summary.className = "";
			summary.setText("Sync is not running. Configure the connection (and passphrase) and restart sync.");
			counts.setText("");
			driftBox.empty();
			treeBox.empty();
			this.driftSig = this.treeSig = "";
			return;
		}

		const drifted = report.localOnly.length + report.dbOnly.length + report.drift.length;
		const total = report.inSync.length + drifted;
		const pct = total === 0 ? 100 : Math.round((report.inSync.length / total) * 100);
		summary.className = drifted === 0 ? "couchdb-sync-ok" : "couchdb-sync-warn";
		summary.setText(
			drifted === 0
				? `✓ In sync — ${report.inSync.length} / ${total} files (100%)`
				: `⚠ Syncing — ${report.inSync.length} / ${total} files (${pct}%) · ${drifted} pending`
		);
		counts.setText(`This device: ${report.vaultCount} files · Database: ${report.dbCount} files`);

		// drift lists — rebuild only when the set changed
		const driftSig = JSON.stringify([report.localOnly, report.dbOnly, report.drift]);
		if (force || driftSig !== this.driftSig) {
			this.driftSig = driftSig;
			driftBox.empty();
			this.renderDriftList(driftBox, "Only on this device (not yet uploaded)", report.localOnly);
			this.renderDriftList(driftBox, "Only in database (not yet downloaded here)", report.dbOnly);
			this.renderDriftList(driftBox, "Content differs (will be resolved by your conflict strategy)", report.drift);
		}

		// file tree — rebuild only when the indexed set changed (keeps it expanded otherwise)
		const treeSig = JSON.stringify(report.allDbPaths);
		if (force || treeSig !== this.treeSig) {
			this.treeSig = treeSig;
			treeBox.empty();
			const tree = treeBox.createEl("details", { cls: "couchdb-sync-tree-root" });
			tree.createEl("summary", { text: `📂 File tree — ${report.allDbPaths.length} indexed files` });
			this.renderTree(tree.createDiv({ cls: "couchdb-sync-tree" }), report.allDbPaths);
		}
	}

	private renderDriftList(box: HTMLElement, title: string, paths: string[]): void {
		if (paths.length === 0) return;
		const det = box.createEl("details", { cls: "couchdb-sync-drift" });
		det.createEl("summary", { text: `${title} (${paths.length})` });
		const ul = det.createEl("ul");
		for (const p of paths) {
			const li = ul.createEl("li", { cls: "couchdb-sync-drift-item" });
			li.createSpan({ cls: "couchdb-sync-dot" }); // pulses when active
			li.createSpan({ text: p, cls: "couchdb-sync-drift-name" });
			const btn = li.createEl("button", { text: "Sync", cls: "couchdb-sync-rowbtn" });
			btn.onclick = async () => {
				btn.disabled = true;
				btn.setText("Syncing…");
				try {
					await this.plugin.forceSyncPath(p);
				} finally {
					this.driftSig = ""; // force the lists to refresh on the next tick
				}
			};
			li.dataset.couchdbPath = p;
		}
	}

	private renderTree(container: HTMLElement, paths: string[]): void {
		interface Node {
			folders: Map<string, Node>;
			files: { name: string; path: string }[];
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
			node.files.push({ name: parts[parts.length - 1], path });
		}

		// red "X": remove a file (folder=false) or whole folder (folder=true) from the
		// DB index. No confirmation — it only touches the database; local files stay and
		// can be re-synced. Refresh the tree afterwards.
		const addRemove = (row: HTMLElement, target: string, folder: boolean) => {
			const x = row.createEl("button", { text: "✕", cls: "couchdb-sync-x" });
			x.setAttr("aria-label", `Remove ${target} from the index`);
			x.onclick = async (ev) => {
				ev.preventDefault();
				ev.stopPropagation();
				x.disabled = true;
				await this.plugin.removeFromIndex(target, folder);
				this.treeSig = ""; // force tree rebuild
				this.driftSig = "";
				await this.loadIndex(true);
			};
		};

		const render = (node: Node, el: HTMLElement, prefix: string) => {
			const folderNames = [...node.folders.keys()].sort((a, b) => a.localeCompare(b));
			for (const name of folderNames) {
				const child = node.folders.get(name)!;
				const folderPath = prefix ? `${prefix}/${name}` : name;
				const det = el.createEl("details");
				const sum = det.createEl("summary", { cls: "couchdb-sync-tree-folder" });
				sum.createSpan({ text: `📁 ${name}` });
				addRemove(sum, folderPath, true);
				render(child, det.createDiv({ cls: "couchdb-sync-tree-children" }), folderPath);
			}
			for (const file of node.files.sort((a, b) => a.name.localeCompare(b.name))) {
				const div = el.createDiv({ cls: "couchdb-sync-tree-file" });
				div.createSpan({ cls: "couchdb-sync-dot" });
				div.createSpan({ text: `📄 ${file.name}`, cls: "couchdb-sync-tree-fname" });
				addRemove(div, file.path, false);
				div.dataset.couchdbPath = file.path;
			}
		};
		render(rootNode, container, "");
	}
}
