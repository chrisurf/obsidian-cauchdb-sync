import { browser, expect } from "@wdio/globals";
import { describe, it, beforeEach } from "mocha";
import assert from "node:assert/strict";
import { obsidianPage } from "wdio-obsidian-service";
import { pluginIsEnabled } from "./helpers.js";

const VAULT = "e2e/vaults/simple";

/**
 * Vault lifecycle layer: create / modify / delete files while the plugin is
 * active and confirm (a) the vault reflects the change and (b) the plugin's
 * registered vault-event handlers survive the churn without disabling the
 * plugin. Exercises the per-test reset harness. No CouchDB server required.
 */
describe("CouchDB Sync — vault lifecycle", function () {
	beforeEach(async function () {
		// Fast in-place reset of vault files (no Obsidian reboot).
		await obsidianPage.resetVault(VAULT);
	});

	it("starts from the committed fixture files", async function () {
		const files = await browser.executeObsidian(({ app }) =>
			app.vault.getMarkdownFiles().map((f) => f.path).sort(),
		);
		assert.deepEqual(files, ["Note.md", "Welcome.md", "folder/Nested.md"]);
	});

	it("reflects a newly created file and keeps the plugin healthy", async function () {
		await browser.executeObsidian(async ({ app }) => {
			await app.vault.create("Created.md", "hello e2e");
		});
		const content = await browser.executeObsidian(async ({ app }) => {
			const f = app.vault.getFileByPath("Created.md");
			return f ? await app.vault.read(f) : null;
		});
		await expect(content).toBe("hello e2e");
		await expect(await pluginIsEnabled()).toBe(true);
	});

	it("reflects a modify and a delete", async function () {
		await browser.executeObsidian(async ({ app }) => {
			const f = app.vault.getFileByPath("Note.md");
			if (f) await app.vault.modify(f, "changed body");
		});
		const modified = await browser.executeObsidian(async ({ app }) => {
			const f = app.vault.getFileByPath("Note.md");
			return f ? await app.vault.read(f) : null;
		});
		await expect(modified).toBe("changed body");

		await browser.executeObsidian(async ({ app }) => {
			const f = app.vault.getFileByPath("folder/Nested.md");
			if (f) await app.vault.delete(f);
		});
		const stillThere = await browser.executeObsidian(({ app }) => !!app.vault.getFileByPath("folder/Nested.md"));
		await expect(stillThere).toBe(false);
		await expect(await pluginIsEnabled()).toBe(true);
	});

	it("resets vault state between tests (previous file is gone)", async function () {
		// Created.md from the earlier test must not leak here thanks to resetVault.
		const exists = await browser.executeObsidian(({ app }) => !!app.vault.getFileByPath("Created.md"));
		await expect(exists).toBe(false);
	});
});
