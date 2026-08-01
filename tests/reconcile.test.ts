// @vitest-environment happy-dom
// pouchdb-browser touches browser globals at import time, so this suite runs under
// a lightweight DOM. The in-memory adapter needs no IndexedDB.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import PouchDB from "pouchdb-browser";
import memoryAdapter from "pouchdb-adapter-memory";
import { SyncEngine } from "../src/engine";
import { SyncDatabase } from "../src/database";
import { DEFAULT_SETTINGS, FILE_PREFIX, type CouchDBSyncSettings, type FileDoc } from "../src/types";

PouchDB.plugin(memoryAdapter);

/**
 * Regression for "live sync doesn't detect/push local changes on mobile".
 *
 * The engine's fast path is vault events (create/modify/delete → a debounced push).
 * On mobile those events are unreliable: the OS throttles timers and suspends the
 * app, so an event can be dropped or fire the debounced push against an engine a
 * resume-triggered restart has already torn down — the edit then never reaches the
 * database and the file looks unsynced. The fix is a periodic reconciliation sweep
 * (reconcileLocal) that re-pushes anything the events missed. These tests drive the
 * engine with an in-memory database and a scripted vault, delivering — and then
 * deliberately NOT delivering — vault events to prove the sweep closes the gap.
 */

interface Entry {
	bytes: Uint8Array;
	mtime: number;
	ctime: number;
	size: number;
}

/** A minimal TFile shape: the change/push path only reads `path` and `stat`. */
interface FakeTFile {
	path: string;
	stat: { mtime: number; ctime: number; size: number };
}

let counter = 0;
let db: SyncDatabase;
let engine: SyncEngine;
let files: Map<string, Entry>;

/** Access the engine's private change-path methods without widening its public API. */
type EngineInternals = {
	handleLocalUpsert(file: FakeTFile): Promise<void>;
	reconcileLocal(): Promise<void>;
	/** the sweep only runs once the initial index has settled; simulate that here */
	initialIndexDone: boolean;
};
const priv = (): EngineInternals => engine as unknown as EngineInternals;

function setFile(path: string, text: string, mtime: number): void {
	const bytes = new TextEncoder().encode(text);
	files.set(path, { bytes, mtime, ctime: mtime, size: bytes.byteLength });
}

function tfile(path: string): FakeTFile {
	const e = files.get(path);
	if (!e) throw new Error(`no such fake file: ${path}`);
	return { path, stat: { mtime: e.mtime, ctime: e.ctime, size: e.size } };
}

function makeApp() {
	const adapter = {
		async readBinary(p: string): Promise<ArrayBuffer> {
			const e = files.get(p);
			if (!e) throw Object.assign(new Error("not found"), { status: 404 });
			// return a standalone ArrayBuffer copy of the bytes
			return e.bytes.slice().buffer;
		},
		async exists(p: string): Promise<boolean> {
			return files.has(p);
		},
		async stat(p: string) {
			const e = files.get(p);
			return e ? { type: "file" as const, mtime: e.mtime, ctime: e.ctime, size: e.size } : null;
		},
	};
	return {
		vault: {
			configDir: ".obsidian",
			on: () => ({}), // event refs are irrelevant here; we invoke handlers directly
			offref: () => undefined,
			getFiles: () => [...files.keys()].map(tfile),
			getAbstractFileByPath: (p: string) => (files.has(p) ? tfile(p) : null),
			adapter,
		},
		fileManager: { trashFile: async () => undefined },
	};
}

function getDoc(path: string): Promise<FileDoc | null> {
	return db.get(FILE_PREFIX + path);
}

beforeEach(() => {
	files = new Map();
	const settings: CouchDBSyncSettings = {
		...DEFAULT_SETTINGS,
		e2eeEnabled: false,
		liveSync: true,
		deviceId: "dev-test",
	};
	db = new SyncDatabase(settings, `mem-reconcile-${counter++}`, { adapter: "memory" });
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	engine = new SyncEngine(makeApp() as any, db, settings, () => undefined);
	// Simulate a live engine that has finished its initial index, so the periodic
	// reconciliation sweep is allowed to run (it is gated until steady state).
	priv().initialIndexDone = true;
});

afterEach(async () => {
	engine.stop();
	await db.destroyLocal().catch(() => undefined);
});

describe("live-sync reconciliation sweep", () => {
	it("pushes a change when the vault event IS delivered (fast path baseline)", async () => {
		setFile("note.md", "v1", 1000);
		await priv().handleLocalUpsert(tfile("note.md"));

		const doc = await getDoc("note.md");
		expect(doc).toBeTruthy();
		expect(doc?.deleted).toBe(false);
		expect(doc?.mtime).toBe(1000);
		expect(doc?.size).toBe(2);
	});

	it("reproduces the bug: a DROPPED modify event leaves the edit stranded, then the sweep heals it", async () => {
		setFile("note.md", "v1", 1000);
		await priv().handleLocalUpsert(tfile("note.md")); // first edit synced normally
		expect((await getDoc("note.md"))?.mtime).toBe(1000);

		// The user edits again, but the "modify" event never arrives (mobile suspend /
		// throttled timer / fired against a torn-down engine). Nothing pushes it.
		setFile("note.md", "v2 is longer", 2000);

		// Bug reproduced: the database still holds the stale version — the on-device
		// edit is invisible to every other device.
		const stale = await getDoc("note.md");
		expect(stale?.mtime).toBe(1000);
		expect(stale?.size).toBe(2);

		// The periodic reconciliation sweep re-pushes it with no vault event at all.
		await priv().reconcileLocal();

		const healed = await getDoc("note.md");
		expect(healed?.mtime).toBe(2000);
		expect(healed?.size).toBe("v2 is longer".length);
		expect(healed?.deleted).toBe(false);
	});

	it("reproduces the bug for a NEW file whose create event was dropped", async () => {
		// The file exists on disk but no "create" event ever reached the engine.
		setFile("fresh.md", "created on the phone", 1500);
		expect(await getDoc("fresh.md")).toBeNull();

		await priv().reconcileLocal();

		const doc = await getDoc("fresh.md");
		expect(doc).toBeTruthy();
		expect(doc?.mtime).toBe(1500);
		expect(doc?.deleted).toBe(false);
	});

	it("tombstones a locally-deleted file whose delete event was missed", async () => {
		setFile("gone.md", "hello", 1000);
		await priv().handleLocalUpsert(tfile("gone.md"));
		expect((await getDoc("gone.md"))?.deleted).toBe(false);

		// Deleted on disk, but the "delete" event was never delivered.
		files.delete("gone.md");
		await priv().reconcileLocal();

		expect((await getDoc("gone.md"))?.deleted).toBe(true);
	});

	it("does not run before the initial index has settled (no race with startup)", async () => {
		priv().initialIndexDone = false; // engine still doing its initial pass
		setFile("early.md", "written during startup", 1200);

		await priv().reconcileLocal();

		// The sweep must stay out of the way until the initial index finishes.
		expect(await getDoc("early.md")).toBeNull();
	});

	it("is a no-op when nothing drifted (idempotent, no spurious writes)", async () => {
		setFile("stable.md", "unchanged", 1000);
		await priv().handleLocalUpsert(tfile("stable.md"));
		const before = await getDoc("stable.md");

		await priv().reconcileLocal();
		await priv().reconcileLocal();

		const after = await getDoc("stable.md");
		// Same revision — an unchanged file must not be rewritten by the sweep.
		expect(after?._rev).toBe(before?._rev);
	});
});
