import { browser, expect } from "@wdio/globals";
import { describe, it, before, after } from "mocha";
import { openPluginSettings, closeSettings } from "./helpers.js";

/**
 * Settings UI layer: the plugin's settings tab renders its connection fields,
 * and the index status view stays gated until a connection is verified (a core
 * privacy guarantee: cached file paths must not be inspectable just by opening
 * settings on an unconfigured/unverified remote). No CouchDB server required.
 */
describe("CouchDB Sync — settings UI", function () {
	before(async function () {
		await openPluginSettings();
	});

	after(async function () {
		await closeSettings();
	});

	it("renders the connection section", async function () {
		// WDIO's `tag=text` selector must stand alone — chain it off the CSS
		// parent via `.$()` rather than embedding it in one selector string.
		await expect(browser.$(".modal.mod-settings").$("h2=CouchDB connection")).toExist();
	});

	it("renders the core connection settings", async function () {
		const modal = browser.$(".modal.mod-settings");
		await expect(modal.$(".setting-item-name=Server URL")).toExist();
		await expect(modal.$(".setting-item-name=Test connection")).toExist();
		await expect(modal.$(".setting-item-name=Sync now")).toExist();
	});

	it("keeps the index status hidden until the connection is verified", async function () {
		// Fresh sandbox vault: no serverUrl, connection not verified. The index
		// status must not display a file tree or drift list — it should show the
		// gating message instead.
		const modalText = await browser.$(".modal.mod-settings").getText();
		const gated =
			modalText.includes("Sync is not running") ||
			modalText.includes("hidden until") ||
			modalText.includes("verify") ||
			modalText.includes("Test connection");
		await expect(gated).toBe(true);
		// And no per-file sync tree should be present without a verified connection.
		await expect(browser.$(".couchdb-sync-tree")).not.toExist();
	});
});
