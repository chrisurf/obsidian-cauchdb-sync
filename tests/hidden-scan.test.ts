import { describe, it, expect } from "vitest";
import { shouldWalkHiddenDir, matchesIgnore, type HiddenScanRules } from "../src/util";
import { defaultHiddenExclude } from "../src/types";

/** Baseline for a vault using the default configuration folder. */
const BASELINE = defaultHiddenExclude(".obsidian");

/**
 * The hidden-file scan prunes whole subtrees instead of walking everything and
 * discarding the result afterwards. Pruning is only safe if a pruned folder can
 * never contain a path that WOULD have been synced — the invariant asserted here.
 */

const on = (exclude: string[]): HiddenScanRules => ({
	syncHidden: true,
	hiddenExclude: exclude,
	hiddenInclude: [],
});

const off = (include: string[]): HiddenScanRules => ({
	syncHidden: false,
	hiddenExclude: [],
	hiddenInclude: include,
});

describe("shouldWalkHiddenDir — hidden sync ON (blacklist)", () => {
	const rules = on(BASELINE);

	it("skips folders covered by an exclude pattern", () => {
		expect(shouldWalkHiddenDir(".obsidian", rules)).toBe(false);
		expect(shouldWalkHiddenDir(".git", rules)).toBe(false);
		expect(shouldWalkHiddenDir(".trash", rules)).toBe(false);
	});

	it("skips nested folders inside an excluded subtree", () => {
		expect(shouldWalkHiddenDir(".obsidian/plugins", rules)).toBe(false);
		expect(shouldWalkHiddenDir(".obsidian/plugins/couchdb-sync/node_modules", rules)).toBe(false);
	});

	it("skips a node_modules folder at any depth (mid-path pattern)", () => {
		expect(shouldWalkHiddenDir(".config/node_modules", rules)).toBe(false);
		expect(shouldWalkHiddenDir(".a/b/node_modules", rules)).toBe(false);
	});

	it("still enters hidden folders that are not excluded", () => {
		expect(shouldWalkHiddenDir(".config", rules)).toBe(true);
		expect(shouldWalkHiddenDir(".notes/drafts", rules)).toBe(true);
	});

	it("enters everything when nothing is excluded", () => {
		expect(shouldWalkHiddenDir(".obsidian", on([]))).toBe(true);
	});

	it("accepts a trailing slash identically", () => {
		expect(shouldWalkHiddenDir(".obsidian/", rules)).toBe(shouldWalkHiddenDir(".obsidian", rules));
		expect(shouldWalkHiddenDir(".config/", rules)).toBe(shouldWalkHiddenDir(".config", rules));
	});
});

describe("shouldWalkHiddenDir — hidden sync OFF (whitelist)", () => {
	it("skips everything when nothing is whitelisted", () => {
		expect(shouldWalkHiddenDir(".obsidian", off([]))).toBe(false);
		expect(shouldWalkHiddenDir(".git", off([]))).toBe(false);
	});

	it("descends towards a whitelisted path", () => {
		const rules = off([".obsidian/snippets/"]);
		expect(shouldWalkHiddenDir(".obsidian", rules)).toBe(true);
		expect(shouldWalkHiddenDir(".obsidian/snippets", rules)).toBe(true);
		expect(shouldWalkHiddenDir(".obsidian/snippets/sub", rules)).toBe(true);
	});

	it("does not descend into sibling folders of a whitelisted path", () => {
		const rules = off([".obsidian/snippets/"]);
		expect(shouldWalkHiddenDir(".obsidian/plugins", rules)).toBe(false);
		expect(shouldWalkHiddenDir(".git", rules)).toBe(false);
	});

	it("handles a whitelisted single file", () => {
		const rules = off([".obsidian/app.json"]);
		expect(shouldWalkHiddenDir(".obsidian", rules)).toBe(true);
		expect(shouldWalkHiddenDir(".obsidian/plugins", rules)).toBe(false);
	});
});

describe("pruning invariant: a pruned folder holds only skipped paths", () => {
	// Mirrors how engine.isSkipped decides for a hidden path, so the walk-level
	// decision and the path-level decision can never disagree.
	const skips = (path: string, r: HiddenScanRules) =>
		r.syncHidden ? matchesIgnore(path, r.hiddenExclude) : !matchesIgnore(path, r.hiddenInclude);

	const dirs = [".obsidian", ".git", ".obsidian/plugins", ".config", ".notes/drafts", ".a/b/node_modules"];
	const children = ["file.md", "deep/nested/file.bin", "x.json"];

	for (const rules of [on(BASELINE), on([]), off([]), off([".obsidian/snippets/"])]) {
		for (const dir of dirs) {
			if (shouldWalkHiddenDir(dir, rules)) continue;
			for (const child of children) {
				it(`${dir}/${child} is skipped when the walk prunes ${dir} (syncHidden=${rules.syncHidden})`, () => {
					expect(skips(`${dir}/${child}`, rules)).toBe(true);
				});
			}
		}
	}
});
