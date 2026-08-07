import { browser, expect } from "@wdio/globals";
import { describe, it, before, after } from "mocha";
import assert from "node:assert/strict";
import { PLUGIN_ID, renderSettingsSnapshot, closeSettings, type SettingsSnapshot } from "./helpers.js";

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
		// Connection and encryption are one collapsible section now; on a fresh vault it
		// is expanded (connection not verified), so its heading is present.
		assert.ok(snap.headings.includes("Connection & encryption"), `headings were: ${snap.headings.join(", ")}`);
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

	it("renders the master sync on/off toggle (not the old timed stop button)", async function () {
		// The status card carries the hard on/off switch; the removed emergency-stop
		// button used the word "Stopped <n>s" and must no longer appear.
		assert.ok(/Sync o(n|ff)/.test(snap.text), `expected a sync on/off toggle; text was: ${snap.text.slice(0, 300)}`);
		assert.ok(!/Stopped \d+s/.test(snap.text), "the old timed emergency-stop button should be gone");
	});

	it("masks the password by default and reveals/re-hides it via the eye toggle", async function () {
		const result = await browser.executeObsidian(({ app }, id) => {
			const a = app as unknown as {
				setting: {
					open?(): void;
					openTab?(tab: unknown): void;
					pluginTabs?: { id: string; containerEl: HTMLElement; update?(): void; display?(): void }[];
					settingTabs?: { id: string; containerEl: HTMLElement; update?(): void; display?(): void }[];
				};
			};
			const tabs = [...(a.setting.pluginTabs ?? []), ...(a.setting.settingTabs ?? [])];
			const tab = tabs.find((t) => t.id === id);
			if (!tab) throw new Error(`settings tab '${id}' not found`);
			a.setting.open?.();
			a.setting.openTab?.(tab);
			if (typeof tab.update === "function") tab.update();
			else if (typeof tab.display === "function") tab.display();

			const items = Array.from(tab.containerEl.querySelectorAll<HTMLElement>(".setting-item"));
			const pw = items.find((el) => el.querySelector(".setting-item-name")?.textContent === "Password");
			if (!pw) throw new Error("Password setting row not found");
			const input = pw.querySelector<HTMLInputElement>("input");
			const btn = pw.querySelector<HTMLElement>(".extra-setting-button, .clickable-icon");
			if (!input || !btn) throw new Error("password input or reveal button not found");

			const before = input.type;
			btn.click();
			const shown = input.type;
			btn.click();
			const hidden = input.type;
			return { before, shown, hidden };
		}, PLUGIN_ID);

		await expect(result.before).toBe("password"); // masked by default
		await expect(result.shown).toBe("text"); // eye toggles it visible
		await expect(result.hidden).toBe("password"); // and back to masked
	});
});
