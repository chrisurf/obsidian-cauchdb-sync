import { describe, it, expect } from "vitest";
import { migrateSettings } from "../src/migrate";
import { CouchDBSyncSettings, DEFAULT_HIDDEN_EXCLUDE, DEFAULT_SETTINGS } from "../src/types";

/** Build a settings object like main.ts does: defaults merged with persisted data. */
function merged(overrides: Record<string, unknown>): CouchDBSyncSettings & Record<string, unknown> {
	return Object.assign({}, DEFAULT_SETTINGS, overrides) as CouchDBSyncSettings & Record<string, unknown>;
}

describe("migrateSettings (v1)", () => {
	it("re-unions the default excludes into a config that dropped .git/.obsidian", () => {
		// Mirrors the real polluted data.json: syncHidden on, .git/ and .obsidian/ missing.
		const s = merged({
			syncHidden: true,
			hiddenExclude: [".trash/", ".DS_Store", "node_modules/", ".obsidian/cache"],
		});
		const changed = migrateSettings(s, 0);
		expect(changed).toBe(true);
		expect(s.hiddenExclude).toContain(".git/");
		expect(s.hiddenExclude).toContain(".obsidian/");
		// user's own extra entries are preserved
		expect(s.hiddenExclude).toContain(".DS_Store");
		// no duplicates introduced
		expect(new Set(s.hiddenExclude).size).toBe(s.hiddenExclude.length);
	});

	it("strips the dead excludePatterns / ignorePatterns keys", () => {
		const s = merged({
			excludePatterns: [".git/", "node_modules/"],
			ignorePatterns: [".trash/"],
		});
		const changed = migrateSettings(s, 0);
		expect(changed).toBe(true);
		expect("excludePatterns" in s).toBe(false);
		expect("ignorePatterns" in s).toBe(false);
	});

	it("is a no-op for a config that already has the full default baseline and no dead keys", () => {
		const s = merged({ hiddenExclude: [...DEFAULT_HIDDEN_EXCLUDE] });
		expect(migrateSettings(s, 0)).toBe(false);
	});

	it("does not run v1 changes when priorVersion is already >= 1 (respects later user edits)", () => {
		// A user who deliberately removed .git/ AFTER migrating must not have it re-added.
		const s = merged({ hiddenExclude: [".DS_Store"], excludePatterns: ["leftover"] });
		const changed = migrateSettings(s, 1);
		expect(changed).toBe(false);
		expect(s.hiddenExclude).toEqual([".DS_Store"]);
		expect("excludePatterns" in s).toBe(true); // gated: not touched at v>=1
	});

	it("is idempotent: a second run after applying v1 changes nothing", () => {
		const s = merged({ hiddenExclude: [".DS_Store"], ignorePatterns: ["x"] });
		migrateSettings(s, 0);
		const secondChanged = migrateSettings(s, 0);
		expect(secondChanged).toBe(false);
	});
});

describe("migrateSettings (v2) — autoStart folded into syncEnabled", () => {
	it("switches sync OFF when auto-start was off, preserving the user's intent", () => {
		// The reported state: master switch on, auto-start off (e.g. turned off by the
		// crash guard) — the combination that produced "SYNC ON … Idle". After the
		// merge it must NOT silently start replicating; it becomes a visible "off".
		const s = merged({ syncEnabled: true, autoStart: false });
		const changed = migrateSettings(s, 1);
		expect(changed).toBe(true);
		expect(s.syncEnabled).toBe(false);
		expect("autoStart" in s).toBe(false);
	});

	it("keeps sync ON when auto-start was on", () => {
		const s = merged({ syncEnabled: true, autoStart: true });
		const changed = migrateSettings(s, 1);
		expect(changed).toBe(true);
		expect(s.syncEnabled).toBe(true);
		expect("autoStart" in s).toBe(false);
	});

	it("leaves an already-off master switch off", () => {
		const s = merged({ syncEnabled: false, autoStart: true });
		migrateSettings(s, 1);
		expect(s.syncEnabled).toBe(false);
	});

	it("is a no-op for a config that never had autoStart", () => {
		const s = merged({ syncEnabled: true });
		expect(migrateSettings(s, 1)).toBe(false);
		expect(s.syncEnabled).toBe(true);
	});

	it("does not re-run for configs already at v2 (respects later user edits)", () => {
		// Someone who switched sync back ON after migrating must keep it on, even if
		// a stale autoStart key is still lying around.
		const s = merged({ syncEnabled: true, autoStart: false });
		expect(migrateSettings(s, 2)).toBe(false);
		expect(s.syncEnabled).toBe(true);
	});

	it("is idempotent", () => {
		const s = merged({ syncEnabled: true, autoStart: false });
		migrateSettings(s, 0);
		expect(migrateSettings(s, 0)).toBe(false);
		expect(s.syncEnabled).toBe(false);
	});

	it("applies both v1 and v2 for a config coming from version 0", () => {
		const s = merged({
			syncHidden: true,
			hiddenExclude: [".DS_Store"],
			autoStart: false,
			excludePatterns: ["dead"],
		});
		expect(migrateSettings(s, 0)).toBe(true);
		expect(s.hiddenExclude).toContain(".git/");
		expect("excludePatterns" in s).toBe(false);
		expect(s.syncEnabled).toBe(false);
		expect("autoStart" in s).toBe(false);
	});
});
