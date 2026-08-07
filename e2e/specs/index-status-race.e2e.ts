import { browser } from "@wdio/globals";
import { describe, it, before, after } from "mocha";
import assert from "node:assert/strict";
import { PLUGIN_ID } from "./helpers.js";

const VIEW_TYPE = "couchdb-sync-status";

/**
 * Regression: the FULL sync panel (the right-sidebar view) loses its details
 * (store trees + summary + counters) when a slow index report overlaps a
 * re-render.
 *
 * Real-world trigger: `buildIndexReport` walks every hidden folder on each run
 * (see listHidden), which on a vault with a large `.obsidian` tree takes tens of
 * seconds. Any second mount in that window (re-opening the panel, a rebuild)
 * replaces the DOM elements while the first run still holds references to the
 * old, now-detached ones.
 *
 * `loadIndexInner` captures its target elements BEFORE the await; the render
 * generation guards against a stale run writing into detached orphans and
 * stamping `driftSig`/`treeSig` for a tree it drew into nothing. This spec drives
 * that race deterministically by gating getIndexReport and asserts the CORRECT
 * behaviour: whatever the interleaving, the visible panel must never end up with
 * the counters rendered but the trees missing.
 *
 * The panel is exercised in its FULL form (the sidebar view). The settings tab
 * deliberately mounts the panel in COMPACT mode (status + counters only, no
 * trees), so the tree-race lives with the full view now.
 */
type RacePanel = {
	mount(root: HTMLElement): void;
	unmount(): void;
	loadIndex(force: boolean): Promise<void>;
	treeSig?: string;
};

describe("CouchDB Sync — full panel under a slow, overlapping report", function () {
	/** Settings as they were before this spec, restored in `after`. */
	let savedSettings: Record<string, unknown> = {};

	before(async function () {
		// Configure enough that the report is not privacy-gated, but keep the master
		// sync switch OFF so no session and no network I/O ever starts. The previous
		// values are captured so this spec cannot leak a verified connection into
		// specs that assert on the unconfigured privacy gate.
		savedSettings = await browser.executeObsidian(
			async ({ app }, id) => {
				const plugin = (
					app as unknown as {
						plugins: {
							plugins: Record<
								string,
								{ settings: Record<string, unknown>; saveSettings(): Promise<void> }
							>;
						};
					}
				).plugins.plugins[id];
				const before = { ...plugin.settings };
				plugin.settings.serverUrl = "https://couch.invalid";
				plugin.settings.dbName = "e2e-race";
				plugin.settings.username = "e2e";
				plugin.settings.connectionVerified = true;
				plugin.settings.syncEnabled = false;
				plugin.settings.e2eeEnabled = false;
				await plugin.saveSettings();
				return before;
			},
			PLUGIN_ID,
		);
	});

	after(async function () {
		// Restore the panel to the view's own host (this spec mounts it into throwaway
		// hosts) and put the settings back exactly as they were — leaving
		// `connectionVerified` behind would unlock the index view for later specs.
		await browser.executeObsidian(
			async ({ app }, id, restore, viewType) => {
				const a = app as unknown as {
					workspace: {
						getLeavesOfType(t: string): { view: { contentEl: HTMLElement; onOpen(): Promise<void>; onClose(): Promise<void> } }[];
					};
					plugins: {
						plugins: Record<string, { settings: Record<string, unknown>; saveSettings(): Promise<void> }>;
					};
				};
				const leaf = a.workspace.getLeavesOfType(viewType)[0];
				if (leaf) {
					// Re-run the view's own mount so it owns a fresh, correctly-hosted panel.
					await leaf.view.onClose();
					await leaf.view.onOpen();
				}
				const plugin = a.plugins.plugins[id];
				Object.assign(plugin.settings, restore);
				await plugin.saveSettings();
			},
			PLUGIN_ID,
			savedSettings,
			VIEW_TYPE,
		);
	});

	/** Open the sidebar view and return its full panel instance. */
	async function fullPanelExists(): Promise<boolean> {
		return browser.executeObsidian(async ({ app }, id, viewType) => {
			const a = app as unknown as {
				workspace: { getLeavesOfType(t: string): { view: { panel?: unknown } }[] };
				plugins: { plugins: Record<string, { revealStatusView(): Promise<void> }> };
			};
			await a.plugins.plugins[id].revealStatusView();
			for (let i = 0; i < 40; i++) {
				const leaf = a.workspace.getLeavesOfType(viewType)[0];
				if (leaf?.view?.panel) return true;
				await new Promise((r) => setTimeout(r, 100));
			}
			return false;
		}, PLUGIN_ID, VIEW_TYPE);
	}

	it("renders the store trees on a normal (fast) render — baseline", async function () {
		assert.equal(await fullPanelExists(), true, "the sidebar view must expose its panel");
		const hasTree = await browser.executeObsidian(async ({ app }, id, viewType) => {
			const a = app as unknown as {
				workspace: { getLeavesOfType(t: string): { view: { panel: RacePanel } }[] };
			};
			void id;
			const panel = a.workspace.getLeavesOfType(viewType)[0].view.panel;
			const host = document.body.createDiv();
			panel.unmount();
			panel.mount(host);
			for (let i = 0; i < 60; i++) {
				if (host.querySelector(".couchdb-sync-tree")) {
					host.remove();
					return true;
				}
				await new Promise((r) => setTimeout(r, 100));
			}
			host.remove();
			return false;
		}, PLUGIN_ID, VIEW_TYPE);

		assert.equal(hasTree, true, "baseline: the store trees should render when nothing races");
	});

	it("keeps the details visible when a slow report overlaps a re-render", async function () {
		const state = await browser.executeObsidian(async ({ app }, id, viewType) => {
			const a = app as unknown as {
				workspace: { getLeavesOfType(t: string): { view: { panel: RacePanel } }[] };
				plugins: { plugins: Record<string, { getIndexReport(): Promise<unknown> }> };
			};
			const plugin = a.plugins.plugins[id];
			const panel = a.workspace.getLeavesOfType(viewType)[0].view.panel;
			const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

			// Gate the report so the interleaving is deterministic: the FIRST call is
			// released on demand, later calls stay pending until the test lets them go —
			// modelling "every report takes tens of seconds", so the run started by the
			// second mount is still in flight when the first one lands.
			const original = plugin.getIndexReport.bind(plugin);
			let releaseFirst!: () => void;
			let releaseRest!: () => void;
			const firstGate = new Promise<void>((r) => (releaseFirst = r));
			const restGate = new Promise<void>((r) => (releaseRest = r));
			let call = 0;
			plugin.getIndexReport = async () => {
				const mine = call++;
				await (mine === 0 ? firstGate : restGate);
				return original();
			};

			const hostA = document.body.createDiv();
			const hostB = document.body.createDiv();
			try {
				panel.unmount();
				panel.mount(hostA); // run 1 — targets host A, blocks on firstGate
				await sleep(100);
				panel.mount(hostB); // run 2 — host B is on screen now, still blocked
				await sleep(100);
				releaseFirst(); // run 1 lands late, against the detached host A
				await sleep(800);

				// Host B is the live element set; a synchronous re-paint of the last known
				// report gives it the trees immediately even while run 2 is still gated.
				const hasTree = !!hostB.querySelector(".couchdb-sync-tree");
				return {
					hasTree,
					legendItems: hostB.querySelectorAll(".couchdb-sync-legend-item").length,
					summary: (hostB.querySelector(".couchdb-sync-summary")?.textContent ?? "").trim(),
					counts: (hostB.querySelector(".couchdb-sync-counts")?.textContent ?? "").trim(),
					sigMatchesDom: !!panel.treeSig === hasTree,
				};
			} finally {
				releaseRest();
				await sleep(400);
				plugin.getIndexReport = original;
				hostA.remove();
				hostB.remove();
			}
		}, PLUGIN_ID, VIEW_TYPE);

		// Diagnostic: this is the exact shape of the reported bug.
		const orphaned = state.legendItems > 0 && !state.hasTree;
		assert.equal(
			orphaned,
			false,
			`stale run wrote into detached elements: counters rendered (${state.legendItems} items) ` +
				`but the trees are missing. summary=${JSON.stringify(state.summary)} ` +
				`counts=${JSON.stringify(state.counts)}`,
		);
		assert.notEqual(
			state.summary,
			"Loading…",
			"the summary must not be left on the placeholder once a report has completed",
		);
		assert.notEqual(state.counts, "", "the store cards must be filled in");
		assert.equal(
			state.sigMatchesDom,
			true,
			"a stale run stamped the render signature for a tree it drew into a detached element",
		);
	});

	it("keeps the periodic refresh working after the race", async function () {
		// The auto-refresh tick uses force=false. It must terminate, must not blank the
		// view, and must leave signature and DOM consistent.
		const state = await browser.executeObsidian(async ({ app }, id, viewType) => {
			const a = app as unknown as {
				workspace: { getLeavesOfType(t: string): { view: { panel: RacePanel } }[] };
			};
			void id;
			const panel = a.workspace.getLeavesOfType(viewType)[0].view.panel;
			const host = document.body.createDiv();
			panel.unmount();
			panel.mount(host);
			await new Promise((r) => setTimeout(r, 400));
			await panel.loadIndex(false); // what the 3 s auto-refresh timer does
			await new Promise((r) => setTimeout(r, 300));
			const hasTree = !!host.querySelector(".couchdb-sync-tree");
			const out = { hasTree, sigMatchesDom: !!panel.treeSig === hasTree };
			host.remove();
			return out;
		}, PLUGIN_ID, VIEW_TYPE);

		assert.equal(state.hasTree, true, "the periodic refresh must not lose the store trees");
		assert.equal(state.sigMatchesDom, true, "render signature and DOM drifted apart");
	});

	it("re-paints the details immediately when the panel is rebuilt", async function () {
		// Rebuilding must not blank the transparency view while a fresh report is still
		// in flight: the last known state is painted synchronously.
		const hasTreeImmediately = await browser.executeObsidian(async ({ app }, id, viewType) => {
			const a = app as unknown as {
				workspace: { getLeavesOfType(t: string): { view: { panel: RacePanel } }[] };
				plugins: { plugins: Record<string, { getIndexReport(): Promise<unknown> }> };
			};
			const plugin = a.plugins.plugins[id];
			const panel = a.workspace.getLeavesOfType(viewType)[0].view.panel;
			// Prime the panel with a real report first, so there is a last-known state.
			const primeHost = document.body.createDiv();
			panel.unmount();
			panel.mount(primeHost);
			for (let i = 0; i < 60; i++) {
				if (primeHost.querySelector(".couchdb-sync-tree")) break;
				await new Promise((r) => setTimeout(r, 100));
			}
			const original = plugin.getIndexReport.bind(plugin);
			// A report that never lands — the view must still show what it knows.
			plugin.getIndexReport = () => new Promise(() => undefined);
			try {
				const host = document.body.createDiv();
				panel.unmount();
				panel.mount(host);
				const has = !!host.querySelector(".couchdb-sync-tree");
				host.remove();
				return has;
			} finally {
				plugin.getIndexReport = original;
				primeHost.remove();
			}
		}, PLUGIN_ID, VIEW_TYPE);

		assert.equal(
			hasTreeImmediately,
			true,
			"the trees must be re-painted from the last known report without waiting for a new one",
		);
	});
});
