import { expect } from "@wdio/globals";
import { describe, it, before, after } from "mocha";
import assert from "node:assert/strict";
import { renderSettingsSnapshot, closeSettings, type SettingsSnapshot } from "./helpers.js";

/**
 * Settings UI layer: the plugin's settings tab renders its connection fields,
 * and the index status view stays gated until a connection is verified (a core
 * privacy guarantee: cached file paths must not be inspectable just by opening
 * settings on an unconfigured/unverified remote). No CouchDB server required.
 *
 * Assertions read the plugin tab's actually-rendered content (see
 * renderSettingsSnapshot) rather than the settings-modal DOM, which Obsidian
 * 1.13.x does not build in the headless test runner.
 */
describe("CouchDB Sync — settings UI", function () {
	let snap: SettingsSnapshot;

	before(async function () {
		snap = await renderSettingsSnapshot();
	});

	after(async function () {
		await closeSettings();
	});

	it("renders the connection section heading", async function () {
		assert.ok(snap.headings.includes("CouchDB connection"), `headings were: ${snap.headings.join(", ")}`);
	});

	it("renders the core connection settings", async function () {
		for (const name of ["Server URL", "Database name", "Username", "Password", "Test connection"]) {
			assert.ok(snap.settingNames.includes(name), `missing setting '${name}'; had: ${snap.settingNames.join(", ")}`);
		}
	});

	it("keeps the index status hidden until the connection is verified", async function () {
		// Fresh sandbox vault: no serverUrl, connection not verified. The per-file
		// sync tree must NOT be rendered — that is the privacy gate.
		await expect(snap.hasTree).toBe(false);
	});
});
