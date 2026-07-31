import { browser } from "@wdio/globals";
import { describe, it, before, after } from "mocha";
import assert from "node:assert/strict";
import { PLUGIN_ID } from "./helpers.js";

/**
 * Regression: the index status view loses its details (file tree + summary +
 * counts) when a slow index report overlaps a re-render of the settings tab.
 *
 * Real-world trigger: `buildIndexReport` walks every hidden folder on each run
 * (see listHidden), which on a vault with a large `.obsidian` tree takes tens of
 * seconds. Any second `display()` in that window (re-opening settings, switching
 * tabs, toggling a setting) replaces the DOM elements while the first run still
 * holds references to the old, now-detached ones.
 *
 * `loadIndexInner` captures summary/counts/drift/tree in local consts BEFORE the
 * await, but reads legend/excluded-toggle from `this` AFTER it. So the stale run
 * writes half its output into detached orphans and half into the live DOM — and
 * it stamps `driftSig`/`treeSig`, which makes every later refresh believe the
 * tree is already up to date and skip rendering it.
 *
 * Observable result (and exactly what the bug report screenshot shows): the
 * legend row and the excluded-files toggle are present, while the summary still
 * says "Loading…" and the whole per-file tree is missing.
 *
 * This spec drives that race deterministically by gating getIndexReport, and
 * asserts the CORRECT behaviour: whatever the interleaving, the visible DOM must
 * never end up with a legend but no tree.
 */
describe("CouchDB Sync — index status under a slow, overlapping report", function () {
	/** Settings as they were before this spec, restored in `after`. */
	let savedSettings: Record<string, unknown> = {};

	before(async function () {
		// Configure enough that the report is not privacy-gated, but keep the
		// master sync switch OFF so no session and no network I/O ever starts.
		// The previous values are captured so this spec cannot leak a verified
		// connection into specs that assert on the unconfigured privacy gate.
		savedSettings = await browser.executeObsidian(
			async ({ app }, id) => {
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
				plugin.settings.serverUrl = "https://couch.invalid";
				plugin.settings.dbName = "e2e-race";
				plugin.settings.username = "e2e";
				plugin.settings.connectionVerified = true;
				plugin.settings.syncEnabled = false;
				plugin.settings.e2eeEnabled = false;
				await plugin.saveSettings();
				// Silence the plugin's own 5 s drift timer so it cannot consume our
				// gated getIndexReport calls and skew the interleaving under test.
				if (plugin.driftRefreshTimer != null) window.clearInterval(plugin.driftRefreshTimer);
				return before;
			},
			PLUGIN_ID,
		);
	});

	after(async function () {
		// Put the settings back exactly as they were — leaving `connectionVerified`
		// behind would unlock the index view for every spec that runs after this one.
		await browser.executeObsidian(
			async ({ app }, id, restore) => {
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
				Object.assign(plugin.settings, restore);
				await plugin.saveSettings();
			},
			PLUGIN_ID,
			savedSettings,
		);
	});

	it("renders the file tree on a normal (fast) render — baseline", async function () {
		const hasTree = await browser.executeObsidian(async ({ app }, id) => {
			const a = app as unknown as {
				setting: { pluginTabs?: { id: string; containerEl: HTMLElement; display(): void }[] };
			};
			const tab = (a.setting.pluginTabs ?? []).find((t) => t.id === id)!;
			tab.display();
			for (let i = 0; i < 60; i++) {
				if (tab.containerEl.querySelector(".couchdb-sync-tree")) return true;
				await new Promise((r) => setTimeout(r, 100));
			}
			return false;
		}, PLUGIN_ID);

		assert.equal(hasTree, true, "baseline: the sync-state tree should render when nothing races");
	});

	it("keeps the details visible when a slow report overlaps a re-render", async function () {
		const state = await browser.executeObsidian(async ({ app }, id) => {
			const a = app as unknown as {
				setting: { pluginTabs?: { id: string; containerEl: HTMLElement; display(): void }[] };
				plugins: { plugins: Record<string, { getIndexReport(): Promise<unknown> }> };
			};
			const plugin = a.plugins.plugins[id];
			const tab = (a.setting.pluginTabs ?? []).find((t) => t.id === id)!;
			const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

			// Gate the report so the interleaving is deterministic: the FIRST call is
			// released on demand, later calls stay pending until the test lets them
			// go — modelling "every report takes tens of seconds", so the run started
			// by the second display() is still in flight when the first one lands.
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

			try {
				tab.display(); // run 1 — targets element set A, blocks on firstGate
				await sleep(100);
				tab.display(); // run 2 — element set B is on screen now, still blocked
				await sleep(100);
				releaseFirst(); // run 1 lands late, against the detached element set A
				await sleep(800);

				const ce = tab.containerEl;
				const hasTree = !!ce.querySelector(".couchdb-sync-tree");
				return {
					hasTree,
					legendItems: ce.querySelectorAll(".couchdb-sync-legend-item").length,
					summary: (ce.querySelector(".couchdb-sync-summary")?.textContent ?? "").trim(),
					counts: (ce.querySelector(".couchdb-sync-counts")?.textContent ?? "").trim(),
					// A stamped render signature must always describe what is really on
					// screen — a stale run stamping it for a tree it drew into an orphan
					// is what made the empty view permanent.
					sigMatchesDom: !!(tab as unknown as { treeSig?: string }).treeSig === hasTree,
				};
			} finally {
				releaseRest(); // let the pending run finish; leave no gate behind
				await sleep(400);
				plugin.getIndexReport = original;
			}
		}, PLUGIN_ID);

		// Diagnostic: this is the exact shape of the reported bug.
		const orphaned = state.legendItems > 0 && !state.hasTree;
		assert.equal(
			orphaned,
			false,
			`stale run wrote into detached elements: legend rendered (${state.legendItems} items) ` +
				`but the tree is missing. summary=${JSON.stringify(state.summary)} ` +
				`counts=${JSON.stringify(state.counts)}`,
		);
		assert.notEqual(
			state.summary,
			"Loading…",
			"the summary must not be left on the placeholder once a report has completed",
		);
		assert.notEqual(state.counts, "", "the counts line must be filled in");
		assert.equal(
			state.sigMatchesDom,
			true,
			"a stale run stamped the render signature for a tree it drew into a detached element",
		);
	});

	it("keeps the periodic refresh working after the race", async function () {
		// The auto-refresh tick uses force=false. It must terminate, must not blank
		// the view, and must leave signature and DOM consistent — i.e. the view stays
		// self-consistent instead of silently skipping a render it still owes.
		const state = await browser.executeObsidian(async ({ app }, id) => {
			const a = app as unknown as {
				setting: {
					pluginTabs?: {
						id: string;
						containerEl: HTMLElement;
						loadIndex(force: boolean): Promise<void>;
						treeSig?: string;
					}[];
				};
			};
			const tab = (a.setting.pluginTabs ?? []).find((t) => t.id === id)!;
			await tab.loadIndex(false); // what the 3 s auto-refresh timer does
			await new Promise((r) => setTimeout(r, 300));
			const hasTree = !!tab.containerEl.querySelector(".couchdb-sync-tree");
			return { hasTree, sigMatchesDom: !!tab.treeSig === hasTree };
		}, PLUGIN_ID);

		assert.equal(state.hasTree, true, "the periodic refresh must not lose the file tree");
		assert.equal(state.sigMatchesDom, true, "render signature and DOM drifted apart");
	});

	it("re-paints the details immediately when the tab is rebuilt", async function () {
		// Reopening settings must not blank the transparency view while a fresh report
		// is still in flight: the last known state is painted synchronously.
		const hasTreeImmediately = await browser.executeObsidian(async ({ app }, id) => {
			const a = app as unknown as {
				setting: { pluginTabs?: { id: string; containerEl: HTMLElement; display(): void }[] };
				plugins: { plugins: Record<string, { getIndexReport(): Promise<unknown> }> };
			};
			const plugin = a.plugins.plugins[id];
			const tab = (a.setting.pluginTabs ?? []).find((t) => t.id === id)!;
			const original = plugin.getIndexReport.bind(plugin);
			// A report that never lands — the view must still show what it knows.
			plugin.getIndexReport = () => new Promise(() => undefined);
			try {
				tab.display();
				return !!tab.containerEl.querySelector(".couchdb-sync-tree");
			} finally {
				plugin.getIndexReport = original;
			}
		}, PLUGIN_ID);

		assert.equal(
			hasTreeImmediately,
			true,
			"the tree must be re-painted from the last known report without waiting for a new one",
		);
	});
});
