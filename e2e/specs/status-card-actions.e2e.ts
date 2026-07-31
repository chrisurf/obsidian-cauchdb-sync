import { browser } from "@wdio/globals";
import { describe, it, before, after } from "mocha";
import assert from "node:assert/strict";
import { PLUGIN_ID } from "./helpers.js";

/**
 * The status card is the plugin's control surface: it must always say what the
 * state is, WHY it is that way, and offer the one action that changes it.
 *
 * These tests pin down the behaviour that replaced the contradictory
 * "SYNC ON … Idle" state — a master switch that claimed sync was on while
 * nothing ran, no way to start one from the card, and a legend entry styled as
 * a button that promised "Sync all now" but had no click handler at count 0.
 */
describe("CouchDB Sync — status card actions", function () {
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
			// Verified (so the index is not privacy-gated) but switched OFF, so no
			// session and no network I/O can start from these tests.
			plugin.settings.serverUrl = "https://couch.invalid";
			plugin.settings.dbName = "e2e-status";
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

	/** Render the settings tab and read the status card back. */
	async function readCard() {
		return browser.executeObsidian(async ({ app }, id) => {
			const a = app as unknown as {
				setting: { pluginTabs?: { id: string; containerEl: HTMLElement; display(): void }[] };
				plugins: { plugins: Record<string, { isRunning(): boolean; isSyncEnabled(): boolean }> };
			};
			const plugin = a.plugins.plugins[id];
			const tab = (a.setting.pluginTabs ?? []).find((t) => t.id === id)!;
			tab.display();
			for (let i = 0; i < 60; i++) {
				if (tab.containerEl.querySelector(".couchdb-sync-legend-item")) break;
				await new Promise((r) => setTimeout(r, 100));
			}
			const ce = tab.containerEl;
			const card = ce.querySelector(".couchdb-sync-card")!;
			const action = card.querySelector<HTMLButtonElement>(".couchdb-sync-primary-action");
			return {
				statusLabel: (card.querySelector(".couchdb-sync-livestatus-label")?.textContent ?? "").trim(),
				detail: (card.querySelector(".couchdb-sync-statusdetail")?.textContent ?? "").trim(),
				actionLabel: (action?.textContent ?? "").trim(),
				hasAction: !!action,
				legend: Array.from(ce.querySelectorAll<HTMLElement>(".couchdb-sync-legend-item")).map((el) => ({
					label: (el.querySelector(".couchdb-sync-legend-label")?.textContent ?? "").trim(),
					count: (el.querySelector(".couchdb-sync-legend-count")?.textContent ?? "").trim(),
					looksClickable: el.classList.contains("couchdb-sync-legend-btn"),
					tooltip: el.getAttribute("aria-label") ?? "",
					hasHandler: typeof el.onclick === "function",
				})),
				// The everyday actions must not be duplicated further down the page.
				settingNames: Array.from(ce.querySelectorAll(".setting-item-name")).map((e) =>
					(e.textContent ?? "").trim(),
				),
				isRunning: plugin.isRunning(),
				isSyncEnabled: plugin.isSyncEnabled(),
			};
		}, PLUGIN_ID);
	}

	/** Flip the master switch and re-read the card. */
	async function setEnabled(enabled: boolean) {
		await browser.executeObsidian(
			async ({ app }, id, on) => {
				const plugin = (
					app as unknown as {
						plugins: { plugins: Record<string, { setSyncEnabled(v: boolean): Promise<void> }> };
					}
				).plugins.plugins[id];
				await plugin.setSyncEnabled(on);
			},
			PLUGIN_ID,
			enabled,
		);
	}

	it("shows no dead controls: an empty group is not styled as a button", async function () {
		const card = await readCard();
		const synced = card.legend.find((l) => l.label === "synced");
		assert.ok(synced, `legend should include a synced entry; had: ${card.legend.map((l) => l.label).join(", ")}`);
		assert.equal(synced.count, "0", `expected 0 synced, got ${synced.count}`);
		assert.equal(synced.looksClickable, false, "an empty group must not look clickable");
		assert.equal(synced.tooltip, "", "an empty group must not promise an action");
		assert.equal(synced.hasHandler, false, "an empty group has nothing to run");
	});

	it("keeps non-empty groups actionable", async function () {
		const card = await readCard();
		const local = card.legend.find((l) => l.label === "local");
		assert.ok(local, "legend should include a local entry");
		assert.notEqual(local.count, "0", "the fixture vault has local-only files");
		assert.equal(local.looksClickable, true, "a non-empty group stays a button");
		assert.equal(local.hasHandler, true, "…and it does something");
		assert.match(local.tooltip, /upload all/i);
	});

	it("explains why nothing is running while sync is off", async function () {
		const card = await readCard();
		assert.equal(card.isSyncEnabled, false);
		assert.equal(card.statusLabel, "Off", `status label was: ${card.statusLabel}`);
		assert.notEqual(card.detail, "", "the card must state the reason, not just the state");
	});

	it("hides the primary action while sync is switched off", async function () {
		// With the master switch off, the toggle is the only meaningful control — a
		// "Sync now" button would contradict the hard kill switch.
		const card = await readCard();
		assert.equal(card.hasAction, false, `unexpected action button: ${card.actionLabel}`);
	});

	it("offers 'Sync now' in the card as soon as sync is on but idle", async function () {
		await setEnabled(true);
		try {
			const card = await readCard();
			assert.equal(card.isSyncEnabled, true);
			assert.equal(card.hasAction, true, "the status card must offer the primary action");
			// Not running (the bogus server never connects) -> the action starts one.
			if (!card.isRunning) {
				assert.equal(card.actionLabel, "Sync now", `action label was: ${card.actionLabel}`);
			} else {
				assert.equal(card.actionLabel, "Stop", `action label was: ${card.actionLabel}`);
			}
		} finally {
			await setEnabled(false);
		}
	});

	it("places the action between the state label and the on/off toggle", async function () {
		await setEnabled(true);
		try {
			const order = await browser.executeObsidian(async ({ app }, id) => {
				const a = app as unknown as {
					setting: { pluginTabs?: { id: string; containerEl: HTMLElement; display(): void }[] };
				};
				const tab = (a.setting.pluginTabs ?? []).find((t) => t.id === id)!;
				tab.display();
				await new Promise((r) => setTimeout(r, 200));
				const row = tab.containerEl.querySelector(".couchdb-sync-livestatus-row")!;
				return Array.from(row.children).map((c) => {
					if (c.classList.contains("couchdb-sync-status-icon")) return "icon";
					if (c.classList.contains("couchdb-sync-livestatus-label")) return "state";
					if (c.classList.contains("couchdb-sync-primary-action")) return "action";
					if (c.classList.contains("couchdb-sync-power")) return "toggle";
					return "other";
				});
			}, PLUGIN_ID);

			// "✓ Not syncing  [ Sync now ]                         SYNC ON ●"
			assert.deepEqual(
				order,
				["icon", "state", "action", "toggle"],
				`unexpected status row layout: ${order.join(" | ")}`,
			);
		} finally {
			await setEnabled(false);
		}
	});

	it("does not repeat the everyday actions further down the page", async function () {
		const card = await readCard();
		for (const gone of ["Sync now", "Stop sync", "Start automatically on launch"]) {
			assert.ok(
				!card.settingNames.includes(gone),
				`"${gone}" should no longer be a separate setting; had: ${card.settingNames.join(", ")}`,
			);
		}
		// …while the non-everyday actions stay available.
		for (const kept of ["Download from server", "Wipe local cache"]) {
			assert.ok(card.settingNames.includes(kept), `"${kept}" should still be available`);
		}
	});
});
