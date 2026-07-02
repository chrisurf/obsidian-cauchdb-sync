// @vitest-environment happy-dom
// pouchdb-browser touches browser globals (self/window) at import time, so this
// suite runs under a lightweight DOM. The in-memory adapter needs no IndexedDB.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import PouchDB from "pouchdb-browser";
import memoryAdapter from "pouchdb-adapter-memory";
import { SyncDatabase } from "../src/database";
import { DEFAULT_SETTINGS, FileDoc } from "../src/types";

PouchDB.plugin(memoryAdapter);

// Each test gets its own in-memory database so nothing leaks between cases.
let counter = 0;
let db: SyncDatabase;

function fileDoc(path: string, over: Partial<FileDoc> = {}): FileDoc {
	return {
		_id: "f:" + path,
		type: "file",
		path,
		mtime: 1000,
		ctime: 1000,
		size: 3,
		deleted: false,
		deviceId: "devA",
		binary: false,
		enc: false,
		children: ["h:aaa"],
		hash: "abc",
		...over,
	};
}

beforeEach(() => {
	db = new SyncDatabase({ ...DEFAULT_SETTINGS }, `mem-test-${counter++}`, { adapter: "memory" });
});

afterEach(async () => {
	await db.destroyLocal().catch(() => undefined);
});

describe("SyncDatabase.getAll — range query never loads chunks/history", () => {
	it("returns only file docs, excluding chunk and version docs", async () => {
		await db.put(fileDoc("a.md"));
		await db.put(fileDoc("b.md"));
		// a chunk doc (h:) — must NEVER be returned by getAll (the old OOM source)
		await db.putChunkIfAbsent("h:aaa", false, new Uint8Array([1, 2, 3]));
		// a history doc (H:) — sorts before f:, must also be excluded
		await (db.local as unknown as PouchDB.Database).put({
			_id: "H:a.md\n000000000001000\nabc",
			type: "version",
			path: "a.md",
		});

		const all = await db.getAll();
		const ids = all.map((d) => d._id).sort();
		expect(ids).toEqual(["f:a.md", "f:b.md"]);
		expect(all.every((d) => d.type === "file")).toBe(true);
	});

	it("includes logical tombstones (deleted:true) but not _deleted docs", async () => {
		await db.put(fileDoc("live.md"));
		await db.put(fileDoc("gone.md", { deleted: true, children: [], hash: "", size: 0 }));
		const all = await db.getAll();
		expect(all.map((d) => d._id).sort()).toEqual(["f:gone.md", "f:live.md"]);
	});
});

describe("SyncDatabase.get", () => {
	it("returns null for a missing id (404), not a throw", async () => {
		expect(await db.get("f:nope.md")).toBeNull();
	});

	it("round-trips a put and reattaches the rev on update", async () => {
		await db.put(fileDoc("x.md", { hash: "h1" }));
		await db.put(fileDoc("x.md", { hash: "h2" })); // put() must fetch existing _rev
		const got = await db.get("f:x.md");
		expect(got?.hash).toBe("h2");
	});
});

describe("SyncDatabase.getConflicted", () => {
	it("detects a document with conflicting leaf revisions", async () => {
		await db.put(fileDoc("c.md", { deviceId: "devA", mtime: 100 }));
		const current = await db.get("f:c.md");
		// inject a competing gen-1 leaf via new_edits:false -> a real conflict
		await (db.local as unknown as PouchDB.Database).bulkDocs(
			[
				{
					...current,
					_rev: "1-00000000000000000000000000000000",
					deviceId: "devB",
					mtime: 200,
				},
			],
			{ new_edits: false }
		);
		const conflicted = await db.getConflicted();
		expect(conflicted.map((d) => d._id)).toEqual(["f:c.md"]);
		expect(conflicted[0]._conflicts?.length).toBe(1);
	});

	it("returns nothing when there are no conflicts", async () => {
		await db.put(fileDoc("clean.md"));
		expect(await db.getConflicted()).toEqual([]);
	});
});

describe("SyncDatabase chunk storage (attachments)", () => {
	it("round-trips raw chunk bytes through an attachment", async () => {
		const bytes = new Uint8Array([9, 8, 7, 6, 5, 0, 255, 128]);
		await db.putChunkIfAbsent("h:rt", false, bytes);
		const c = await db.getChunkLocal("h:rt");
		expect(c?.enc).toBe(false);
		expect(Array.from(c!.bytes)).toEqual(Array.from(bytes));
	});

	it("putChunkIfAbsent is idempotent and never throws on a duplicate (first write wins)", async () => {
		await db.putChunkIfAbsent("h:dup", false, new Uint8Array([1]));
		await db.putChunkIfAbsent("h:dup", false, new Uint8Array([2]));
		const c = await db.getChunkLocal("h:dup");
		expect(Array.from(c!.bytes)).toEqual([1]); // immutable — original kept
	});

	it("preserves the enc flag", async () => {
		await db.putChunkIfAbsent("h:enc", true, new Uint8Array([42, 42]));
		const c = await db.getChunkLocal("h:enc");
		expect(c?.enc).toBe(true);
	});

	it("getChunkLocal returns null for a missing chunk", async () => {
		expect(await db.getChunkLocal("h:missing")).toBeNull();
	});
});

describe("SyncDatabase version history", () => {
	it("putVersionIfAbsent is idempotent and listVersions is chronological", async () => {
		const mk = (ts: string, hash: string) => ({
			_id: `H:note.md\n${ts}\n${hash}`,
			type: "version" as const,
			path: "note.md",
			ts: Number(ts),
			mtime: Number(ts),
			size: 1,
			hash,
			deviceId: "devA",
			binary: false,
			enc: false,
			children: [],
			deleted: false,
		});
		await db.putVersionIfAbsent(mk("000000000000002", "hh2"));
		await db.putVersionIfAbsent(mk("000000000000001", "hh1"));
		await db.putVersionIfAbsent(mk("000000000000001", "hh1")); // duplicate — ignored
		const vers = await db.listVersions("note.md");
		expect(vers.map((v) => v.hash)).toEqual(["hh1", "hh2"]); // oldest -> newest by padded ts
	});

	it("listVersions is scoped to the exact path", async () => {
		const base = (path: string) => ({
			_id: `H:${path}\n000000000000001\nx`,
			type: "version" as const,
			path,
			ts: 1,
			mtime: 1,
			size: 1,
			hash: "x",
			deviceId: "d",
			binary: false,
			enc: false,
			children: [],
			deleted: false,
		});
		await db.putVersionIfAbsent(base("one.md"));
		await db.putVersionIfAbsent(base("two.md"));
		expect((await db.listVersions("one.md")).length).toBe(1);
	});
});

describe("SyncDatabase per-device local docs", () => {
	it("putLocalDoc / getLocalDoc round-trip and update", async () => {
		await db.putLocalDoc("_local/state", { records: { "a.md": { mtime: 1, size: 2, hash: "h" } } });
		await db.putLocalDoc("_local/state", { records: { "a.md": { mtime: 9, size: 2, hash: "h9" } } });
		const doc = await db.getLocalDoc<{ records: Record<string, { hash: string }> }>("_local/state");
		expect(doc?.records["a.md"].hash).toBe("h9");
	});

	it("getLocalDoc returns null when absent", async () => {
		expect(await db.getLocalDoc("_local/missing")).toBeNull();
	});
});
