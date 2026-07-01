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
