import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";
import { PLUGIN_ID, pluginIsEnabled, callPlugin, pluginSettings } from "./helpers.js";

/**
 * Command layer: the registered commands run without a configured/verified
 * remote, exercise the plugin's safe no-op / privacy paths, and never crash the
 * plugin. No CouchDB server required.
 */
describe("CouchDB Sync — commands (no server)", function () {
	it("reports origin state 'unset' on a fresh vault", async function () {
		const state = await callPlugin<string>("getOriginState");
		await expect(state).toBe("unset");
	});

	it("returns a null index report while unconfigured (privacy gate)", async function () {
		const report = await callPlugin("getIndexReport");
		await expect(report).toBe(null);
	});

	it("runs 'Wipe local cache' safely and stays healthy", async function () {
		await browser.executeObsidianCommand(`${PLUGIN_ID}:wipe-local-cache`);
		await expect(await pluginIsEnabled()).toBe(true);
	});

	it("toggles the master sync switch off and back on, persisting the state", async function () {
		// starts enabled by default
		await expect((await pluginSettings<{ syncEnabled: boolean }>()).syncEnabled).toBe(true);

		await browser.executeObsidianCommand(`${PLUGIN_ID}:toggle-sync`);
		await browser.pause(500);
		await expect((await pluginSettings<{ syncEnabled: boolean }>()).syncEnabled).toBe(false);
		await expect(await pluginIsEnabled()).toBe(true);

		await browser.executeObsidianCommand(`${PLUGIN_ID}:toggle-sync`);
		await browser.pause(500);
		await expect((await pluginSettings<{ syncEnabled: boolean }>()).syncEnabled).toBe(true);
		await expect(await pluginIsEnabled()).toBe(true);
	});

	it("runs 'Sync now' unconfigured without crashing", async function () {
		await browser.executeObsidianCommand(`${PLUGIN_ID}:force-sync`);
		await browser.pause(500);
		await expect(await pluginIsEnabled()).toBe(true);
	});
});
