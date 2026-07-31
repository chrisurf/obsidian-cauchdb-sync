import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";
import assert from "node:assert/strict";
import { PLUGIN_ID, pluginIsEnabled, commandIds } from "./helpers.js";

/**
 * Smoke layer: the plugin boots inside a real Obsidian, registers its public
 * surface (commands, status bar, settings tab) and does not throw on load.
 * No CouchDB server required.
 */
describe("CouchDB Sync — plugin load", function () {
	it("is loaded and enabled", async function () {
		await expect(await pluginIsEnabled()).toBe(true);
	});

	it("registers its commands", async function () {
		const ids = await commandIds();
		const mine = ids.filter((c) => c.startsWith(`${PLUGIN_ID}:`)).sort();
		assert.deepEqual(mine, [
			`${PLUGIN_ID}:couchdb-sync-now`,
			`${PLUGIN_ID}:couchdb-sync-stop`,
			`${PLUGIN_ID}:couchdb-sync-toggle`,
			`${PLUGIN_ID}:couchdb-sync-wipe-local`,
		]);
	});

	it("shows a status bar item", async function () {
		const statusText = browser.$(".status-bar .couchdb-sync-status-text");
		await expect(statusText).toExist();
		// Initial state label always starts with "CouchDB".
		await expect(statusText).toHaveText(expect.stringContaining("CouchDB"));
	});

	it("adds a settings tab for the plugin", async function () {
		// The setting tab id equals the plugin id. Community-plugin tabs live in
		// `pluginTabs` (core tabs are in `settingTabs`), so check both.
		const hasTab = await browser.executeObsidian(({ app }, id) => {
			const setting = (app as unknown as {
				setting: { settingTabs: { id: string }[]; pluginTabs: { id: string }[] };
			}).setting;
			const inCore = setting.settingTabs?.some((t) => t.id === id) ?? false;
			const inPlugins = setting.pluginTabs?.some((t) => t.id === id) ?? false;
			return inCore || inPlugins;
		}, PLUGIN_ID);
		await expect(hasTab).toBe(true);
	});
});
