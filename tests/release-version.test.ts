import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs helper, no type declarations by design
import { classifyCommit, classifyBump, nextVersion, computeNextVersion } from "../scripts/release-version.mjs";

describe("classifyCommit — conventional-commit -> bump level", () => {
	it("maps feat to minor", () => {
		expect(classifyCommit("feat: add a hard on/off sync toggle")).toBe("minor");
		expect(classifyCommit("feat(engine): stream large chunks")).toBe("minor");
	});

	it("maps fix / perf / refactor / docs / chore to patch", () => {
		for (const t of ["fix", "perf", "refactor", "docs", "chore", "ci", "test", "style", "build", "revert"]) {
			expect(classifyCommit(`${t}: something`)).toBe("patch");
		}
	});

	it("treats a trailing ! as a breaking (major) change", () => {
		expect(classifyCommit("feat!: drop legacy cache format")).toBe("major");
		expect(classifyCommit("fix(db)!: rename document prefixes")).toBe("major");
	});

	it("treats a BREAKING CHANGE footer as major", () => {
		expect(classifyCommit("feat: x\n\nBREAKING CHANGE: storage layout changed")).toBe("major");
		expect(classifyCommit("chore: y\n\nBREAKING-CHANGE: nope")).toBe("major");
	});

	it("ignores our own release commits so they never re-trigger a release", () => {
		expect(classifyCommit("chore(release): 0.34.0")).toBe(null);
	});

	it("falls back to patch for non-conventional subjects (still a real merge)", () => {
		expect(classifyCommit("random commit without a type")).toBe("patch");
	});
});

describe("classifyBump — highest level across a set", () => {
	it("returns null for an empty range or only release commits", () => {
		expect(classifyBump([])).toBe(null);
		expect(classifyBump(["chore(release): 1.0.0"])).toBe(null);
	});

	it("picks the most significant level present", () => {
		expect(classifyBump(["fix: a", "feat: b", "docs: c"])).toBe("minor");
		expect(classifyBump(["fix: a", "feat!: b"])).toBe("major");
		expect(classifyBump(["fix: a", "chore: b"])).toBe("patch");
	});

	it("skips release commits but still sees real ones", () => {
		expect(classifyBump(["chore(release): 0.9.0", "fix: real"])).toBe("patch");
	});
});

describe("nextVersion — SemVer arithmetic", () => {
	it("bumps patch", () => expect(nextVersion("0.33.0", "patch")).toBe("0.33.1"));
	it("bumps minor and resets patch", () => expect(nextVersion("0.33.4", "minor")).toBe("0.34.0"));
	it("bumps major and resets minor+patch", () => expect(nextVersion("0.33.4", "major")).toBe("1.0.0"));
	it("rejects a malformed version", () => expect(() => nextVersion("0.33", "patch")).toThrow());
});

describe("computeNextVersion — end to end", () => {
	it("returns null when nothing is releasable", () => {
		expect(computeNextVersion("0.33.0", ["chore(release): 0.33.0"])).toBe(null);
	});

	it("computes the next version from a mixed range", () => {
		expect(computeNextVersion("0.33.0", ["fix: a", "feat: b"])).toBe("0.34.0");
		expect(computeNextVersion("0.33.0", ["fix: a"])).toBe("0.33.1");
		expect(computeNextVersion("0.33.0", ["feat!: breaking"])).toBe("1.0.0");
	});
});
