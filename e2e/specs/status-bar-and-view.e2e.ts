import { browser } from "@wdio/globals";
import { describe, it, before, after } from "mocha";
import assert from "node:assert/strict";
import { PLUGIN_ID } from "./helpers.js";

const VIEW_TYPE = "couchdb-sync-status";

/**
 * The status bar is a control surface, not just a read-out: its icon is the
 * on/off switch and its label opens the full status panel in the right sidebar. The panel is the SAME component the settings tab embeds, so the two
 * cannot drift apart — these tests check that both mount a working panel with the
 * per-file lists and actions, not a read-only copy.
 */
describe("CouchDB Sync — status bar controls and sidebar view", function () {
	let savedSettings: Record<string, unknown> = {};

	before(async function () {
		savedSettings = await browser.executeObsidian(async ({ app }, id) => {
			const plugin = (
				app as unknown as {
					plugins: {
						plugins: Record<
							string,
							{
								settings: Record<string, unknown>;
								saveSettings(): Promise<void>;
								driftRefreshTimer?: number;
							}
						>;
					};
				}
			).plugins.plugins[id];
			const before = { ...plugin.settings };
			// Verified so the panel is not privacy-gated, but switched off so nothing
			// reaches a network unless a test explicitly starts a session.
			plugin.settings.serverUrl = "https://couch.invalid";
			plugin.settings.dbName = "e2e-statusbar";
			plugin.settings.username = "e2e";
			plugin.settings.connectionVerified = true;
			plugin.settings.syncEnabled = false;
			plugin.settings.e2eeEnabled = false;
			await plugin.saveSettings();
			if (plugin.driftRefreshTimer != null) window.clearInterval(plugin.driftRefreshTimer);
			return before;
		}, PLUGIN_ID);
	});

	after(async function () {
		await browser.executeObsidian(
			async ({ app }, id, restore, viewType) => {
				const a = app as unknown as {
					workspace: { detachLeavesOfType(t: string): void };
					plugins: {
						plugins: Record<
							string,
							{ settings: Record<string, unknown>; saveSettings(): Promise<void> }
						>;
					};
				};
				a.workspace.detachLeavesOfType(viewType);
				const plugin = a.plugins.plugins[id];
				Object.assign(plugin.settings, restore);
				await plugin.saveSettings();
			},
			PLUGIN_ID,
			savedSettings,
			VIEW_TYPE,
		);
	});

	it("renders both status-bar halves as controls", async function () {
		const bar = await browser.executeObsidian(() => {
			const el = document.querySelector(".couchdb-sync-status")!;
			const icon = el.querySelector<HTMLElement>(".couchdb-sync-status-icon")!;
			const text = el.querySelector<HTMLElement>(".couchdb-sync-status-text")!;
			return {
				iconClickable: typeof icon.onclick === "function",
				textClickable: typeof text.onclick === "function",
				iconIsBtn: icon.classList.contains("couchdb-sync-status-btn"),
				textIsBtn: text.classList.contains("couchdb-sync-status-btn"),
				iconTip: icon.getAttribute("aria-label") ?? "",
				textTip: text.getAttribute("aria-label") ?? "",
				label: text.textContent ?? "",
			};
		});

		assert.equal(bar.iconClickable, true, "the icon must switch sync on and off");
		assert.equal(bar.textClickable, true, "the label must open the panel");
		assert.equal(bar.iconIsBtn, true, "the icon must be styled as a control");
		assert.equal(bar.textIsBtn, true, "the label must be styled as a control");
		// Every control states what it does — the two halves do different things.
		assert.match(bar.iconTip, /turn sync (on|off)/i, `icon tooltip was: ${bar.iconTip}`);
		assert.match(bar.textTip, /panel/i, `label tooltip was: ${bar.textTip}`);
		assert.notEqual(bar.iconTip, bar.textTip, "the two halves must not share one label");
	});

	it("switches sync on and off from the status-bar icon", async function () {
		// The icon is the on/off switch, not a third behaviour: the plugin has exactly
		// two controls — a switch for WHETHER this vault syncs, and "Sync now" for
		// doing it once. Turning the switch on must start a session by itself; no
		// second click on "Sync now" should be required.
		const res = await browser.executeObsidian(async ({ app }, id) => {
			const plugin = (
				app as unknown as {
					plugins: {
						plugins: Record<
							string,
							{ isRunning(): boolean; isSyncEnabled(): boolean; setSyncEnabled(v: boolean): Promise<void> }
						>;
					};
				}
			).plugins.plugins[id];
			const icon = document.querySelector<HTMLElement>(".couchdb-sync-status-icon")!;
			const settle = () => new Promise((r) => setTimeout(r, 400));

			const before = { enabled: plugin.isSyncEnabled(), running: plugin.isRunning() };
			icon.click(); // off -> on, and a session starts on its own
			await settle();
			const afterOn = { enabled: plugin.isSyncEnabled(), running: plugin.isRunning() };
			icon.click(); // on -> off, session torn down
			await settle();
			const afterOff = { enabled: plugin.isSyncEnabled(), running: plugin.isRunning() };

			await plugin.setSyncEnabled(false);
			return { before, afterOn, afterOff };
		}, PLUGIN_ID);

		assert.deepEqual(res.before, { enabled: false, running: false }, "precondition");
		assert.deepEqual(
			res.afterOn,
			{ enabled: true, running: true },
			"turning the switch on must start syncing without a further click",
		);
		assert.deepEqual(res.afterOff, { enabled: false, running: false }, "turning it off must stop everything");
	});

	it("opens the status panel in the right sidebar from the status-bar label", async function () {
		const res = await browser.executeObsidian(async ({ app }, id, viewType) => {
			const a = app as unknown as {
				workspace: { getLeavesOfType(t: string): unknown[] };
			};
			const text = document.querySelector<HTMLElement>(".couchdb-sync-status-text")!;
			const before = a.workspace.getLeavesOfType(viewType).length;
			text.click();
			for (let i = 0; i < 40; i++) {
				if (document.querySelector(".couchdb-sync-view .couchdb-sync-card")) break;
				await new Promise((r) => setTimeout(r, 100));
			}
			const view = document.querySelector(".couchdb-sync-view");
			return {
				leavesBefore: before,
				leavesAfter: a.workspace.getLeavesOfType(viewType).length,
				hasCard: !!view?.querySelector(".couchdb-sync-card"),
				hasLegend: !!view?.querySelector(".couchdb-sync-legend-item"),
				pluginId: id,
			};
		}, PLUGIN_ID, VIEW_TYPE);

		assert.equal(res.leavesBefore, 0, "no panel should be open beforehand");
		assert.equal(res.leavesAfter, 1, "clicking the label must open exactly one panel");
		assert.equal(res.hasCard, true, "the panel must render the status card");
		assert.equal(res.hasLegend, true, "the panel must render the legend");
	});

	it("gives the sidebar panel the same working tree and actions as the settings tab", async function () {
		const res = await browser.executeObsidian(async ({ app }, id, viewType) => {
			const a = app as unknown as {
				workspace: { getLeavesOfType(t: string): unknown[] };
				setting: { pluginTabs?: { id: string; containerEl: HTMLElement; display(): void }[] };
			};
			// Panel already open from the previous test; render settings alongside it.
			const tab = (a.setting.pluginTabs ?? []).find((t) => t.id === id)!;
			tab.display();
			for (let i = 0; i < 40; i++) {
				if (tab.containerEl.querySelector(".couchdb-sync-tree")) break;
				await new Promise((r) => setTimeout(r, 100));
			}
			const view = document.querySelector(".couchdb-sync-view")!;

			const shape = (root: ParentNode) => ({
				tree: !!root.querySelector(".couchdb-sync-tree"),
				files: root.querySelectorAll("[data-couchdb-path]").length,
				// The per-file "…" menus are what make the panel manageable, not just readable.
				actionButtons: root.querySelectorAll(".couchdb-sync-iconbtn").length,
				legendItems: root.querySelectorAll(".couchdb-sync-legend-item").length,
			});

			return {
				view: shape(view),
				settings: shape(tab.containerEl),
				bothOpen: a.workspace.getLeavesOfType(viewType).length === 1,
			};
		}, PLUGIN_ID, VIEW_TYPE);

		assert.equal(res.bothOpen, true, "the sidebar panel should still be open");
		assert.equal(res.view.tree, true, "the sidebar panel must render the file tree");
		assert.ok(res.view.files > 0, "the sidebar panel must list files");
		assert.ok(res.view.actionButtons > 0, "the sidebar panel must offer per-file actions");
		// Same component, so the two must agree on what they show.
		assert.deepEqual(
			res.view,
			res.settings,
			"the sidebar panel and the settings tab must render the same panel",
		);
	});

	it("stops the panel's timers when the sidebar is closed", async function () {
		const res = await browser.executeObsidian(async ({ app }, id, viewType) => {
			const a = app as unknown as {
				workspace: {
					getLeavesOfType(t: string): { view: { panel?: { indexLoad?: unknown; autoRefresh?: number } } }[];
					detachLeavesOfType(t: string): void;
				};
			};
			const leaf = a.workspace.getLeavesOfType(viewType)[0];
			const panel = leaf?.view?.panel as { autoRefresh?: number } | undefined;
			const timerWhileOpen = panel?.autoRefresh;
			a.workspace.detachLeavesOfType(viewType);
			await new Promise((r) => setTimeout(r, 200));
			return {
				hadTimer: timerWhileOpen !== undefined,
				timerAfterClose: panel?.autoRefresh,
				leaves: a.workspace.getLeavesOfType(viewType).length,
				pluginId: id,
			};
		}, PLUGIN_ID, VIEW_TYPE);

		assert.equal(res.hadTimer, true, "an open panel refreshes on a timer");
		// Loose check: the bridge serialises `undefined` as `null`.
		assert.ok(
			res.timerAfterClose == null,
			`a closed panel must not keep refreshing (timer was ${res.timerAfterClose})`,
		);
		assert.equal(res.leaves, 0, "the panel should be gone");
	});
});
