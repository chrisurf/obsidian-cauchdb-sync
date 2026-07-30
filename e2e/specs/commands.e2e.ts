import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";
import { PLUGIN_ID, pluginIsEnabled, callPlugin } from "./helpers.js";

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
		await browser.executeObsidianCommand(`${PLUGIN_ID}:couchdb-sync-wipe-local`);
		await expect(await pluginIsEnabled()).toBe(true);
	});

	it("runs 'Stop sync' when nothing is running without crashing", async function () {
		await browser.executeObsidianCommand(`${PLUGIN_ID}:couchdb-sync-stop`);
		await expect(await pluginIsEnabled()).toBe(true);
	});

	it("runs 'Sync now' unconfigured without crashing", async function () {
		await browser.executeObsidianCommand(`${PLUGIN_ID}:couchdb-sync-now`);
		await browser.pause(500);
		await expect(await pluginIsEnabled()).toBe(true);
	});
});
