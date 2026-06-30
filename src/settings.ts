import { App, Menu, PluginSettingTab, Setting, Notice, setIcon } from "obsidian";
import type CouchDBSyncPlugin from "./main";
import { SyncDatabase } from "./database";
import { selfTest } from "./crypto";
import { HistoryModal, confirm } from "./history";
import { SYNC_STATE, SyncStatus } from "./types";

const AUTO_REFRESH_MS = 3_000;

/** How a file relates to this device vs the database (drives the colour coding).
 *   excluded — filtered out by the skip rules (not synced)     (dimmed)
 *   synced   — on this device and in sync                      (green)
 *   remote   — in the database only, not on this device        (grey)
 *   local    — on this device only, not in the database        (amber)
 *   drift    — on both, content differs (auto-reconcilable)    (purple)
 *   conflict — unresolved conflict revisions in the database   (red)
 */
type FileState = "excluded" | "synced" | "remote" | "local" | "drift" | "conflict";

/** Syncable states (everything except the informational "excluded"). */
const SYNCABLE: FileState[] = ["synced", "remote", "local", "drift", "conflict"];

/**
 * Single severity ordering used everywhere: it decides which state a file gets
 * when several apply, the order the lists are shown in, and the colour a folder
 * rolls up to (the most urgent state anywhere inside it). One table = one source
 * of truth, so the summary, the lists, the files and the folders never disagree.
 * "excluded" is the lowest — a folder is only dimmed when it is entirely excluded.
 */
const SEVERITY: Record<FileState, number> = {
	excluded: 0,
	synced: 1,
	remote: 2,
	local: 3,
	drift: 4,
	conflict: 5,
};

export class CouchDBSyncSettingTab extends PluginSettingTab {
	plugin: CouchDBSyncPlugin;
	private statusUnsub?: () => void;
	private autoRefresh?: number;
	private activeTimer?: number;
	private liveStatusEl?: HTMLElement;
	// persistent index-status elements (updated in place to avoid flicker)
	private summaryEl?: HTMLElement;
	private countsEl?: HTMLElement;
	private legendEl?: HTMLElement;
	private driftEl?: HTMLElement;
	private treeEl?: HTMLElement;
	private excludedToggleEl?: HTMLElement;
	private driftSig = "";
	private treeSig = "";
	private openSections = new Set<string>();
	private indexLoading = false; // prevent overlapping loadIndex() runs (PouchDB connection races)

	constructor(app: App, plugin: CouchDBSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	hide(): void {
		if (this.driftEl) this.saveOpenState(this.driftEl);
		if (this.treeEl) this.saveOpenState(this.treeEl);
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
					await db.close();
					if (res.ok) {
						await this.plugin.markConnectionVerified();
						this.driftSig = ""; // force the index view to refresh
						this.treeSig = "";
					}
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

		new Setting(containerEl)
			.setName("Forget local cache when plugin is disabled")
			.setDesc(
				"Privacy mode. When you disable or uninstall the plugin, the local PouchDB " +
					"(containing UNENCRYPTED file paths, sizes, and hashes — even with E2EE on) " +
					"is destroyed. Trade-off: re-enabling forces a full re-download from the server. " +
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

	// --- index status view -------------------------------------------------

	private renderIndexStatus(root: HTMLElement): void {
		// --- status card: live status + summary + legend in one visual block ---
		const card = root.createDiv({ cls: "couchdb-sync-card" });

		this.liveStatusEl = card.createDiv({ cls: "couchdb-sync-livestatus" });
		this.statusUnsub?.();
		this.statusUnsub = this.plugin.onStatusChange((st) => this.renderLiveStatus(st));

		this.summaryEl = card.createDiv({ cls: "couchdb-sync-summary" });
		this.countsEl = card.createDiv({ cls: "couchdb-sync-counts" });
		this.legendEl = card.createDiv({ cls: "couchdb-sync-legend" });

		this.summaryEl.setText("Loading…");

		// --- index content (drift lists + tree + excluded toggle) ---
		const box = root.createDiv({ cls: "couchdb-sync-index" });
		this.driftEl = box.createDiv();
		this.treeEl = box.createDiv();
		this.excludedToggleEl = box.createDiv();
		this.driftSig = "";
		this.treeSig = "";

		void this.loadIndex(true);

		if (this.autoRefresh !== undefined) window.clearInterval(this.autoRefresh);
		this.autoRefresh = window.setInterval(() => void this.loadIndex(false), AUTO_REFRESH_MS);

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
		// Re-entrancy guard. The auto-refresh interval fires every AUTO_REFRESH_MS,
		// but the previous call may still be in flight (slow IDB, big vault). Two
		// concurrent runs would open the same PouchDB twice and the second close()
		// can race with the first's pending IDB transactions ("connection is closing").
		if (this.indexLoading && !force) return;
		this.indexLoading = true;
		try {
			await this.loadIndexInner(force);
		} finally {
			this.indexLoading = false;
		}
	}

	private async loadIndexInner(force: boolean): Promise<void> {
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
			const s = this.plugin.settings;
			if (!s.serverUrl) {
				summary.setText("Sync is not running. Configure the connection (and passphrase) and restart sync.");
				driftBox.empty();
			} else if (!s.connectionVerified) {
				summary.setText(
					"Index status is hidden until the server connection is verified. Press 'Test connection' above — on success the index unlocks."
				);
				driftBox.empty();
			} else {
				// Verified, but the report still came back null — most likely an origin
				// mismatch (cache was stamped by a different remote). Tell the user and
				// expose the two recovery actions: wipe (safe default) or re-stamp
				// (adopt the cache for this remote, if they know it is theirs).
				const origin = await this.plugin.getOriginState().catch(() => "unset" as const);
				if (origin === "mismatch") {
					summary.className = "couchdb-sync-warn";
					summary.setText(
						"⚠ Local cache belongs to a different remote (server URL / database / username changed since it was filled). " +
							"Its contents are hidden to avoid showing files from the previous remote."
					);
					driftBox.empty();
					const actions = driftBox.createDiv({ cls: "couchdb-sync-drift" });
					const wipeBtn = actions.createEl("button", {
						text: "Wipe local cache",
						cls: "couchdb-sync-rowbtn",
					});
					wipeBtn.onclick = async () => {
						await this.plugin.wipeLocalOnly();
						new Notice("Local cache wiped. Press 'Sync now' to rebuild from the new remote.");
						this.display();
					};
					const adoptBtn = actions.createEl("button", {
						text: "Adopt cache for this remote",
						cls: "couchdb-sync-rowbtn",
					});
					adoptBtn.onclick = async () => {
						await this.plugin.stampOriginFingerprint();
						new Notice("Cache adopted for the current remote.");
						this.driftSig = "";
						this.treeSig = "";
						await this.loadIndex(true);
					};
				} else {
					summary.setText("Sync is not running. Press 'Sync now' or 'Download only' to start.");
					driftBox.empty();
				}
			}
			counts.setText("");
			this.legendEl?.empty();
			treeBox.empty();
			this.driftSig = this.treeSig = "";
			return;
		}

		// ---- single source of truth: classify every file into exactly one state ----
		// Each file gets the most severe state that applies (see SEVERITY). The same
		// map drives the summary, the lists below, and the tree — so they can never
		// disagree.
		const stateByPath = new Map<string, FileState>();
		const setState = (p: string, s: FileState) => {
			const cur = stateByPath.get(p);
			if (cur === undefined || SEVERITY[s] > SEVERITY[cur]) stateByPath.set(p, s);
		};
		for (const p of report.inSync) setState(p, "synced");
		for (const p of report.dbOnly) setState(p, "remote");
		for (const p of report.localOnly) setState(p, "local");
		for (const p of report.drift) setState(p, "drift");
		for (const p of report.conflicts) setState(p, "conflict");
		if (this.plugin.settings.showExcluded) {
			for (const p of report.excluded) setState(p, "excluded");
		}

		const groups: Record<FileState, string[]> = {
			excluded: [],
			synced: [],
			remote: [],
			local: [],
			drift: [],
			conflict: [],
		};
		for (const [p, s] of stateByPath) groups[s].push(p);
		for (const k of Object.keys(groups) as FileState[]) groups[k].sort((a, b) => a.localeCompare(b));

		const allPaths = [...stateByPath.keys()].sort((a, b) => a.localeCompare(b));
		// the summary counts only SYNCABLE files; excluded are informational
		const syncTotal = SYNCABLE.reduce((n, s) => n + groups[s].length, 0);
		const pending = syncTotal - groups.synced.length;
		const pct = syncTotal === 0 ? 100 : Math.round((groups.synced.length / syncTotal) * 100);

		summary.className = "couchdb-sync-summary";
		if (pending === 0) {
			summary.addClass("couchdb-sync-summary-ok");
			summary.setText(`${groups.synced.length} / ${syncTotal} files in sync`);
		} else {
			summary.addClass("couchdb-sync-summary-pending");
			summary.setText(`${groups.synced.length} / ${syncTotal} files (${pct}%) · ${pending} pending`);
		}
		counts.setText(`This device: ${report.vaultCount} files · Database: ${report.dbCount} files`);

		// legend (in the card, above the tree) — actionable items are clickable
		const legendBox = this.legendEl;
		if (legendBox) {
			legendBox.empty();
			const p = this.plugin;
			const refreshAfter = async () => {
				this.driftSig = "";
				this.treeSig = "";
				await this.loadIndex(true);
			};

			const totalItem = legendBox.createSpan({ cls: "couchdb-sync-legend-total" });
			totalItem.createSpan({ text: `${syncTotal}`, cls: "couchdb-sync-legend-count" });
			totalItem.createSpan({ text: "total", cls: "couchdb-sync-legend-label" });

			type LegendAction = { tooltip: string; busyLabel: string; run: (path: string) => Promise<unknown> } | null;
			const mk = (state: FileState, label: string, count: number, action: LegendAction) => {
				if (count === 0 && state === "excluded") return;
				const hasAction = action !== null;
				const enabled = hasAction && count > 0;
				const cls = `couchdb-sync-legend-item couchdb-sync-state-${state}` +
					(hasAction ? " couchdb-sync-legend-btn" : "") +
					(hasAction && !enabled ? " couchdb-sync-legend-disabled" : "");
				const item = legendBox.createSpan({ cls });
				if (hasAction) item.ariaLabel = action.tooltip;
				item.createSpan({ cls: `couchdb-sync-swatch couchdb-sync-state-${state}` });
				item.createSpan({ text: `${count}`, cls: "couchdb-sync-legend-count" });
				const labelEl = item.createSpan({ text: label, cls: "couchdb-sync-legend-label" });
				if (enabled) {
					item.onclick = async () => {
						item.classList.add("couchdb-sync-legend-busy");
						const origLabel = labelEl.getText();
						labelEl.setText(action.busyLabel);
						try {
							for (const path of groups[state]) await action.run(path);
							new Notice(`CouchDB Sync: ${action.busyLabel.replace("…", "")} ${count} file(s).`);
						} catch (e) {
							new Notice(`CouchDB Sync: error — ${e instanceof Error ? e.message : String(e)}`);
						} finally {
							labelEl.setText(origLabel);
							item.classList.remove("couchdb-sync-legend-busy");
							await refreshAfter();
						}
					};
				}
			};

			mk("synced", "synced", groups.synced.length, null);
			mk("local", "local", groups.local.length, {
				tooltip: "Upload all to server",
				busyLabel: "Uploading…",
				run: (path) => p.takeLocalPath(path),
			});
			mk("remote", "remote", groups.remote.length, {
				tooltip: "Download all to this device",
				busyLabel: "Downloading…",
				run: (path) => p.takeRemotePath(path),
			});
			mk("drift", "differs", groups.drift.length, {
				tooltip: "Resolve all (use newest)",
				busyLabel: "Resolving…",
				run: (path) => p.useNewestPath(path),
			});
			mk("conflict", "conflict", groups.conflict.length, {
				tooltip: "Resolve all conflicts (use newest)",
				busyLabel: "Resolving…",
				run: (path) => p.useNewestPath(path),
			});
			mk("excluded", "excluded", groups.excluded.length, null);
		}

		// ---- save open/closed state of all <details> before rebuilding ----
		this.saveOpenState(driftBox);
		this.saveOpenState(treeBox);

		// ---- per-state lists, most urgent first (same colours as the tree) ----
		const listSig = JSON.stringify([groups.conflict, groups.drift, groups.local, groups.remote]);
		if (force || listSig !== this.driftSig) {
			this.driftSig = listSig;
			driftBox.empty();
			this.renderStateList(driftBox, "conflict", "Conflicts", groups.conflict);
			this.renderStateList(driftBox, "drift", "Differs", groups.drift);
			this.renderStateList(driftBox, "local", "Local only", groups.local);
			this.renderStateList(driftBox, "remote", "Remote only", groups.remote);
			this.restoreOpenState(driftBox);
		}

		// ---- tree: the complete file set (this device + database) ----
		const treeSig = JSON.stringify(allPaths.map((p) => [p, stateByPath.get(p)]));
		if (force || treeSig !== this.treeSig) {
			this.treeSig = treeSig;
			treeBox.empty();
			const tree = treeBox.createEl("details", { cls: "couchdb-sync-section" });
			tree.dataset.sectionId = "sync-tree";
			const treeSummary = tree.createEl("summary", { cls: "couchdb-sync-section-header" });
			treeSummary.createSpan({ text: "Sync state" });
			treeSummary.createSpan({ text: `${allPaths.length}`, cls: "couchdb-sync-section-count" });
			const body = tree.createDiv({ cls: "couchdb-sync-tree" });
			this.renderTree(body.createDiv(), allPaths, stateByPath);
			this.restoreOpenState(treeBox);
		}

		// --- excluded-files toggle: only visible when excluded files exist ---
		const toggleBox = this.excludedToggleEl;
		if (toggleBox) {
			toggleBox.empty();
			if (report.excluded.length > 0) {
				new Setting(toggleBox)
					.setName(`Show ${report.excluded.length} excluded hidden file(s)`)
					.setDesc(
						"Hidden files (dot-folders like .obsidian or .git) that are skipped by your sync rules. " +
						"Turn on to reveal them in the tree above so you can sync individual files once."
					)
					.addToggle((t) =>
						t.setValue(this.plugin.settings.showExcluded).onChange(async (v) => {
							this.plugin.settings.showExcluded = v;
							await this.plugin.saveSettings();
							this.treeSig = "";
							await this.loadIndex(true);
						})
					);
			}
		}
	}

	private saveOpenState(root: HTMLElement): void {
		root.querySelectorAll<HTMLDetailsElement>("details[data-section-id]").forEach((det) => {
			if (det.open) this.openSections.add(det.dataset.sectionId!);
			else this.openSections.delete(det.dataset.sectionId!);
		});
	}

	private restoreOpenState(root: HTMLElement): void {
		root.querySelectorAll<HTMLDetailsElement>("details[data-section-id]").forEach((det) => {
			det.open = this.openSections.has(det.dataset.sectionId!);
		});
	}

	private renderStateList(
		box: HTMLElement,
		state: FileState,
		title: string,
		paths: string[]
	): void {
		if (paths.length === 0) return;
		const det = box.createEl("details", { cls: `couchdb-sync-section couchdb-sync-state-${state}` });
		det.dataset.sectionId = `list-${state}`;
		const sum = det.createEl("summary", { cls: "couchdb-sync-section-header" });
		sum.createSpan({ text: title });
		sum.createSpan({ text: `${paths.length}`, cls: "couchdb-sync-section-count" });
		const ul = det.createEl("ul", { cls: "couchdb-sync-section-list" });
		const actionLabel = state === "local" ? "Upload" : state === "remote" ? "Download" : "Sync";
		const busyLabel = state === "local" ? "Uploading…" : state === "remote" ? "Downloading…" : "Syncing…";
		for (const p of paths) {
			const li = ul.createEl("li", { cls: "couchdb-sync-drift-item" });
			li.createSpan({ cls: "couchdb-sync-dot" }); // pulses when active
			li.createSpan({ text: p, cls: "couchdb-sync-drift-name" });
			const btn = li.createEl("button", { text: actionLabel, cls: "couchdb-sync-rowbtn" });
			btn.onclick = async () => {
				btn.disabled = true;
				btn.setText(busyLabel);
				try {
					await this.plugin.forceSyncPath(p);
				} finally {
					this.driftSig = ""; // force the lists to refresh on the next tick
				}
			};
			li.dataset.couchdbPath = p;
		}
	}

	private renderTree(
		container: HTMLElement,
		paths: string[],
		stateByPath: Map<string, FileState>
	): void {
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

		// A folder rolls up to the MOST URGENT state anywhere inside it (by SEVERITY).
		// So a folder is green only when its whole subtree is in sync, and turns red
		// the moment anything inside conflicts — no expanding needed to spot trouble.
		const folderState = (node: Node): FileState => {
			let worst: FileState = "excluded";
			const visit = (n: Node) => {
				for (const f of n.files) {
					const s = stateByPath.get(f.path) ?? "remote";
					if (SEVERITY[s] > SEVERITY[worst]) worst = s;
				}
				for (const child of n.folders.values()) visit(child);
			};
			visit(node);
			return worst;
		};

		const stateTitle: Record<FileState, string> = {
			synced: "On this device and in sync with the database",
			local: "On this device only — not yet uploaded to the database",
			remote: "In the database only — not downloaded to this device",
			drift: "On both sides but the content differs — will be reconciled by your conflict strategy",
			conflict: "Unresolved conflict revisions in the database — needs attention",
			excluded: "Excluded by the skip rules — not synced (you can still sync it once)",
		};

		// --- shared action helpers ---
		const p = this.plugin;
		const refresh = async () => {
			this.treeSig = "";
			this.driftSig = "";
			await this.loadIndex(true);
		};
		const run = async (verb: string, fn: () => Promise<unknown>) => {
			try {
				await fn();
				new Notice(`CouchDB Sync: ${verb}`);
			} catch (e) {
				new Notice(`CouchDB Sync: ${verb} failed — ${e instanceof Error ? e.message : String(e)}`);
			} finally {
				await refresh();
			}
		};
		const runMany = async (verb: string, list: string[], fn: (q: string) => Promise<unknown>) => {
			let ok = 0;
			for (const q of list) {
				try {
					await fn(q);
					ok++;
				} catch {
					/* keep going; report the tally */
				}
			}
			new Notice(`CouchDB Sync: ${verb} ${ok}/${list.length}`);
			await refresh();
		};

		const iconBtn = (row: HTMLElement, icon: string, label: string, onClick: (ev: MouseEvent) => void) => {
			const b = row.createEl("button", { cls: "couchdb-sync-iconbtn" });
			setIcon(b, icon);
			b.setAttr("aria-label", label);
			b.onclick = (ev) => {
				ev.preventDefault();
				ev.stopPropagation();
				onClick(ev);
			};
			return b;
		};

		// context-aware per-file actions menu (only what makes sense for the state)
		const fileMenu = (ev: MouseEvent, path: string, state: FileState) => {
			const m = new Menu();
			if (state === "drift" || state === "conflict") {
				m.addItem((i) => i.setTitle("Use newest version").setIcon("clock").onClick(async () => {
					try {
						const side = await p.useNewestPath(path);
						new Notice(`CouchDB Sync: took ${side} version (newest)`);
					} catch (e) {
						new Notice(`CouchDB Sync: use newest failed — ${e instanceof Error ? e.message : String(e)}`);
					} finally {
						await refresh();
					}
				}));
				m.addItem((i) => i.setTitle("Use server version (overwrite local)").setIcon("download").onClick(() => run("downloaded server version", () => p.takeRemotePath(path))));
				m.addItem((i) => i.setTitle("Use local version (overwrite server)").setIcon("upload").onClick(() => run("uploaded local version", () => p.takeLocalPath(path))));
			} else if (state === "remote") {
				m.addItem((i) => i.setTitle("Download to this device").setIcon("download").onClick(() => run("downloaded", () => p.takeRemotePath(path))));
			} else if (state === "local") {
				m.addItem((i) => i.setTitle("Upload to server").setIcon("upload").onClick(() => run("uploaded", () => p.takeLocalPath(path))));
			}
			m.addItem((i) => i.setTitle(state === "excluded" ? "Sync once" : "Sync now").setIcon("refresh-cw").onClick(() => run("synced", () => p.forceSyncPath(path))));
			m.addItem((i) => i.setTitle("Show history…").setIcon("history").onClick(() => new HistoryModal(p, path, refresh).open()));
			m.addSeparator();
			if (state !== "remote") {
				m.addItem((i) => i.setTitle("Delete on this device").setIcon("trash").onClick(() =>
					confirm(this.app, { title: "Delete on this device?", body: `Removes "${path}" from this device only. The server keeps its copy (it may re-download while live sync is on).`, cta: "Delete here", danger: true, onConfirm: () => run("deleted locally", () => p.deleteLocalPath(path)) })));
			}
			if (state === "synced" || state === "remote" || state === "drift" || state === "conflict") {
				m.addItem((i) => i.setTitle("Delete everywhere").setIcon("trash-2").onClick(() =>
					confirm(this.app, { title: "Delete everywhere?", body: `Deletes "${path}" on ALL devices. It stays in history and can be restored.`, cta: "Delete everywhere", danger: true, onConfirm: () => run("deleted everywhere", () => p.deleteEverywherePath(path)) })));
			}
			if (state !== "local") {
				m.addItem((i) => i.setTitle("Remove from database index (keep local)").setIcon("database").onClick(() =>
					confirm(this.app, { title: "Remove from index?", body: `Stops syncing "${path}" and removes it from the database. Every device keeps its local copy; it re-appears if re-indexed.`, cta: "Remove from index", onConfirm: () => run("removed from index", () => p.removeFromIndex(path, false)) })));
			}
			m.showAtMouseEvent(ev);
		};

		// folder bulk actions, applied to the descendant files of the relevant state
		const folderMenu = (ev: MouseEvent, folderPath: string) => {
			const prefix = folderPath + "/";
			const under = paths.filter((q) => q === folderPath || q.startsWith(prefix));
			const byState = (states: FileState[]) => under.filter((q) => states.includes(stateByPath.get(q) ?? "remote"));
			const dl = byState(["remote", "drift", "conflict"]);
			const ul = byState(["local", "drift", "conflict"]);
			const m = new Menu();
			const diverged = byState(["drift", "conflict"]);
			if (diverged.length) m.addItem((i) => i.setTitle(`Use newest for ${diverged.length} differing`).setIcon("clock").onClick(() => runMany("used newest", diverged, (q) => p.useNewestPath(q))));
			if (dl.length) m.addItem((i) => i.setTitle(`Download ${dl.length} to this device`).setIcon("download").onClick(() => runMany("downloaded", dl, (q) => p.takeRemotePath(q))));
			if (ul.length) m.addItem((i) => i.setTitle(`Upload ${ul.length} to server`).setIcon("upload").onClick(() => runMany("uploaded", ul, (q) => p.takeLocalPath(q))));
			m.addItem((i) => i.setTitle("Sync all now").setIcon("refresh-cw").onClick(() => runMany("synced", byState(SYNCABLE), (q) => p.forceSyncPath(q))));
			m.addSeparator();
			m.addItem((i) => i.setTitle("Delete folder on this device").setIcon("trash").onClick(() =>
				confirm(this.app, { title: "Delete folder on this device?", body: `Removes ${under.length} file(s) under "${folderPath}" from this device only.`, cta: "Delete here", danger: true, onConfirm: () => runMany("deleted locally", byState(["synced", "local", "drift", "conflict", "excluded"]), (q) => p.deleteLocalPath(q)) })));
			m.addItem((i) => i.setTitle("Delete folder everywhere").setIcon("trash-2").onClick(() =>
				confirm(this.app, { title: "Delete folder everywhere?", body: `Deletes every file under "${folderPath}" on ALL devices. Restorable from history.`, cta: "Delete everywhere", danger: true, onConfirm: () => runMany("deleted everywhere", byState(["synced", "remote", "drift", "conflict"]), (q) => p.deleteEverywherePath(q)) })));
			m.addItem((i) => i.setTitle("Remove folder from index (keep local)").setIcon("database").onClick(() =>
				confirm(this.app, { title: "Remove folder from index?", body: `Stops syncing everything under "${folderPath}". Local files are kept everywhere.`, cta: "Remove from index", onConfirm: () => run("removed folder from index", () => p.removeFromIndex(folderPath, true)) })));
			m.showAtMouseEvent(ev);
		};

		const render = (node: Node, el: HTMLElement, prefix: string) => {
			const folderNames = [...node.folders.keys()].sort((a, b) => a.localeCompare(b));
			for (const name of folderNames) {
				const child = node.folders.get(name)!;
				const folderPath = prefix ? `${prefix}/${name}` : name;
				const fState = folderState(child);
				const det = el.createEl("details");
				det.dataset.sectionId = `folder-${folderPath}`;
				const sum = det.createEl("summary", {
					cls: `couchdb-sync-tree-folder couchdb-sync-state-${fState}`,
				});
				sum.setAttr("aria-label", stateTitle[fState]);
				sum.createSpan({ text: `📁 ${name}` });
				iconBtn(sum, "more-horizontal", "Folder actions", (ev) => folderMenu(ev, folderPath));
				render(child, det.createDiv({ cls: "couchdb-sync-tree-children" }), folderPath);
			}
			for (const file of node.files.sort((a, b) => a.name.localeCompare(b.name))) {
				const fState = stateByPath.get(file.path) ?? "remote";
				const div = el.createDiv({ cls: `couchdb-sync-tree-file couchdb-sync-state-${fState}` });
				div.setAttr("aria-label", stateTitle[fState]);
				div.createSpan({ cls: "couchdb-sync-dot" });
				div.createSpan({ text: `📄 ${file.name}`, cls: "couchdb-sync-tree-fname" });
				iconBtn(div, "more-horizontal", "Actions", (ev) => fileMenu(ev, file.path, fState));
				div.dataset.couchdbPath = file.path;
			}
		};
		render(rootNode, container, "");
	}
}
