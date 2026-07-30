import { describe, it, expect } from "vitest";
import { pickConflictWinner } from "../src/util";

type Cand = { deviceId?: string; mtime?: number; hash?: string; tag: string };

describe("pickConflictWinner", () => {
	it("newest strategy: largest mtime wins", () => {
		const cands: Cand[] = [
			{ deviceId: "a", mtime: 100, tag: "old" },
			{ deviceId: "b", mtime: 300, tag: "new" },
			{ deviceId: "c", mtime: 200, tag: "mid" },
		];
		expect(pickConflictWinner(cands, "newest", null).tag).toBe("new");
	});

	it("newest strategy ignores masterId entirely", () => {
		const cands: Cand[] = [
			{ deviceId: "master", mtime: 10, tag: "master-but-old" },
			{ deviceId: "b", mtime: 999, tag: "newest" },
		];
		expect(pickConflictWinner(cands, "newest", "master").tag).toBe("newest");
	});

	it("master strategy: the master device's revision wins even if older", () => {
		const cands: Cand[] = [
			{ deviceId: "b", mtime: 999, tag: "newer-other" },
			{ deviceId: "master", mtime: 1, tag: "master" },
		];
		expect(pickConflictWinner(cands, "master", "master").tag).toBe("master");
	});

	it("master strategy falls back to newest when the master rev is absent", () => {
		const cands: Cand[] = [
			{ deviceId: "x", mtime: 100, tag: "old" },
			{ deviceId: "y", mtime: 400, tag: "new" },
		];
		expect(pickConflictWinner(cands, "master", "master").tag).toBe("new");
	});

	it("master strategy with null masterId behaves like newest", () => {
		const cands: Cand[] = [
			{ deviceId: "x", mtime: 100, tag: "old" },
			{ deviceId: "y", mtime: 400, tag: "new" },
		];
		expect(pickConflictWinner(cands, "master", null).tag).toBe("new");
	});

	it("treats a missing mtime as 0 (never wins over a real timestamp)", () => {
		const cands: Cand[] = [
			{ deviceId: "a", tag: "no-mtime" },
			{ deviceId: "b", mtime: 5, tag: "has-mtime" },
		];
		expect(pickConflictWinner(cands, "newest", null).tag).toBe("has-mtime");
	});

	it("does not mutate the input array order", () => {
		const cands: Cand[] = [
			{ deviceId: "a", mtime: 1, tag: "first" },
			{ deviceId: "b", mtime: 9, tag: "second" },
		];
		pickConflictWinner(cands, "newest", null);
		expect(cands.map((c) => c.tag)).toEqual(["first", "second"]);
	});

	// B5: on an mtime tie the winner MUST be deterministic across devices, or two
	// devices resolving the same conflict pick different sides and never converge.
	it("breaks an mtime tie deterministically by hash, regardless of input order", () => {
		const a: Cand = { deviceId: "a", mtime: 100, hash: "aaa", tag: "A" };
		const b: Cand = { deviceId: "b", mtime: 100, hash: "bbb", tag: "B" };
		expect(pickConflictWinner([a, b], "newest", null).tag).toBe("B");
		expect(pickConflictWinner([b, a], "newest", null).tag).toBe("B"); // same winner either order
	});

	it("mtime+hash tie falls back to deviceId deterministically", () => {
		const a: Cand = { deviceId: "dev-a", mtime: 100, hash: "same", tag: "A" };
		const b: Cand = { deviceId: "dev-b", mtime: 100, hash: "same", tag: "B" };
		expect(pickConflictWinner([a, b], "newest", null).tag).toBe("B");
		expect(pickConflictWinner([b, a], "newest", null).tag).toBe("B");
	});

	it("a real mtime difference still beats the tie-break", () => {
		const older: Cand = { deviceId: "z", mtime: 100, hash: "zzz", tag: "older" };
		const newer: Cand = { deviceId: "a", mtime: 200, hash: "aaa", tag: "newer" };
		expect(pickConflictWinner([older, newer], "newest", null).tag).toBe("newer");
		expect(pickConflictWinner([newer, older], "newest", null).tag).toBe("newer");
	});
});
