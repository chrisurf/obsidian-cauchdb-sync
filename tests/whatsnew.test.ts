import { describe, it, expect } from "vitest";
import {
	shouldShowWhatsNew,
	WHATS_NEW,
	HERO_IMAGE_URL,
	BUY_ME_A_COFFEE_URL,
	BUY_ME_A_COFFEE_IMAGE_URL,
} from "../src/whatsnew";
import { DEFAULT_SETTINGS } from "../src/types";

describe("shouldShowWhatsNew", () => {
	it("shows on a fresh install, where no version has been seen", () => {
		expect(shouldShowWhatsNew("0.34.0", "")).toBe(true);
	});

	it("shows after an update to a different version", () => {
		expect(shouldShowWhatsNew("0.35.0", "0.34.0")).toBe(true);
	});

	it("does not show twice for the same version", () => {
		expect(shouldShowWhatsNew("0.34.0", "0.34.0")).toBe(false);
	});

	it("does not show when the running version is unknown", () => {
		expect(shouldShowWhatsNew("", "")).toBe(false);
	});

	it("is due for a default (never-stamped) config", () => {
		expect(shouldShowWhatsNew("0.34.0", DEFAULT_SETTINGS.lastWhatsNewVersion)).toBe(true);
	});
});

describe("what's new content", () => {
	it("leads with connecting a server, the step a fresh install is blocked on", () => {
		expect(WHATS_NEW).toMatch(/^## 🔌 First time here\? Connect a server/);
		expect(WHATS_NEW).toMatch(/Test connection/);
	});

	it("warns that the passphrase must match and cannot be recovered", () => {
		expect(WHATS_NEW).toMatch(/passphrase/i);
		expect(WHATS_NEW).toMatch(/identical on every device/);
	});

	it("covers the status-bar controls and the one-switch-one-action split", () => {
		expect(WHATS_NEW).toMatch(/status bar/i);
		expect(WHATS_NEW).toMatch(/sidebar/);
		expect(WHATS_NEW).toMatch(/Force sync/);
	});

	// The source is hard-wrapped, so the command name can straddle a newline that
	// Markdown collapses on render. Match across whitespace rather than re-flowing
	// the prose to suit the assertion.
	it("names the command the closing line tells the reader to run", () => {
		expect(WHATS_NEW).toMatch(/Open sync\s+status panel/);
	});

	it("points at assets in this repository, so the images resolve after release", () => {
		expect(HERO_IMAGE_URL).toContain("chrisurf/obsidian-cauchdb-sync");
		expect(HERO_IMAGE_URL).toMatch(/\/assets\/hero\.png$/);
		expect(BUY_ME_A_COFFEE_IMAGE_URL).toContain("chrisurf/obsidian-cauchdb-sync");
		expect(BUY_ME_A_COFFEE_IMAGE_URL).toMatch(/\/assets\/buymeacoffee\.png$/);
		expect(BUY_ME_A_COFFEE_URL).toBe("https://www.buymeacoffee.com/chrisurf");
	});
});
