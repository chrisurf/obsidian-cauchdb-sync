import { describe, it, expect } from "vitest";
import { buildMergeBlocks, mergeResult, type MergeBlock } from "../src/util";

/** Flip a change block's choice (test helper mirroring the modal's arrows). */
function choose(blocks: MergeBlock[], predicate: (b: MergeBlock, i: number) => boolean, side: "local" | "remote"): void {
	blocks.forEach((b, i) => {
		if (b.type === "change" && predicate(b, i)) b.choice = side;
	});
}

describe("buildMergeBlocks", () => {
	it("returns a single equal block for identical text", () => {
		const blocks = buildMergeBlocks("a\nb\nc", "a\nb\nc");
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toEqual({ type: "equal", lines: ["a", "b", "c"] });
	});

	it("defaults every change block to the local side (no silent data loss)", () => {
		const blocks = buildMergeBlocks("local\ncommon", "remote\ncommon");
		const change = blocks.find((b) => b.type === "change");
		expect(change).toBeTruthy();
		expect(change && change.type === "change" && change.choice).toBe("local");
	});

	it("keeps local left and remote right", () => {
		const blocks = buildMergeBlocks("L", "R");
		const change = blocks.find((b) => b.type === "change");
		expect(change && change.type === "change" && change.local).toEqual(["L"]);
		expect(change && change.type === "change" && change.remote).toEqual(["R"]);
	});
});

describe("mergeResult", () => {
	it("defaults to the full local text", () => {
		const local = "a\nX\nc";
		const remote = "a\nY\nc";
		expect(mergeResult(buildMergeBlocks(local, remote))).toBe(local);
	});

	it("take-all-remote reproduces the remote text", () => {
		const local = "a\nX\nc\nZ";
		const remote = "a\nY\nc";
		const blocks = buildMergeBlocks(local, remote);
		choose(blocks, () => true, "remote");
		expect(mergeResult(blocks)).toBe(remote);
	});

	it("take-all-local reproduces the local text", () => {
		const local = "a\nX\nc\nZ";
		const remote = "a\nY\nc";
		const blocks = buildMergeBlocks(local, remote);
		choose(blocks, () => true, "local");
		expect(mergeResult(blocks)).toBe(local);
	});

	it("composes a mixed per-block merge", () => {
		// Two independent change blocks: keep local for the first, remote for the second.
		const local = "top-local\nsame\nbottom-local";
		const remote = "top-remote\nsame\nbottom-remote";
		const blocks = buildMergeBlocks(local, remote);
		const changeIdx = blocks.map((b, i) => (b.type === "change" ? i : -1)).filter((i) => i >= 0);
		expect(changeIdx.length).toBe(2);
		// first change -> local, second change -> remote
		(blocks[changeIdx[0]] as Extract<MergeBlock, { type: "change" }>).choice = "local";
		(blocks[changeIdx[1]] as Extract<MergeBlock, { type: "change" }>).choice = "remote";
		expect(mergeResult(blocks)).toBe("top-local\nsame\nbottom-remote");
	});

	it("handles pure insertions (one side has extra lines)", () => {
		const local = "a\nb";
		const remote = "a\nb\nc\nd";
		const blocks = buildMergeBlocks(local, remote);
		// keep remote -> the inserted lines are adopted
		choose(blocks, () => true, "remote");
		expect(mergeResult(blocks)).toBe(remote);
		// keep local -> insertion dropped
		choose(blocks, () => true, "local");
		expect(mergeResult(blocks)).toBe(local);
	});
});
