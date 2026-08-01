// @vitest-environment happy-dom
// pouchdb-browser touches browser globals at import time, so this suite runs under
// a lightweight DOM. The in-memory adapter needs no IndexedDB.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import PouchDB from "pouchdb-browser";
import memoryAdapter from "pouchdb-adapter-memory";
import { TFile } from "obsidian";
import { SyncEngine } from "../src/engine";
import { SyncDatabase } from "../src/database";
import {
	DEFAULT_SETTINGS,
	FILE_PREFIX,
	type CouchDBSyncSettings,
	type FileDoc,
	type SyncRecord,
} from "../src/types";

PouchDB.plugin(memoryAdapter);

/**
 * Regression for the two-way "live sync is slow to converge" bug.
 *
 * PUSH (this device → remote): the fast path is vault events. On mobile the OS
 * throttles timers and suspends the app, so a create/modify can be dropped or fire
 * the debounced push against a torn-down engine, and the edit never reaches the DB.
 *
 * PULL (remote → this device): the live feed writes an incoming file's docs into the
 * local database, but materializing them to disk competes with this device's own
 * upload work — so a file another device just made can sit in the DB, undisplayed,
 * while a large local index runs. This is the "the desktop never shows the file the
 * phone created" report.
 *
 * The fix is a periodic reconcile() that pulls new remote files to disk first, then
 * re-pushes local changes the events missed. These tests drive the real engine with
 * an in-memory database and a scripted, writable vault, and deliberately withhold the
 * fast-path signals to prove the sweep closes both gaps.
 */

interface Entry {
	bytes: Uint8Array;
	mtime: number;
	ctime: number;
	size: number;
}

let counter = 0;
let db: SyncDatabase;
let engine: SyncEngine;
let files: Map<string, Entry>;

// Mirror of engine.ts LIVE_SYNC_RESTART_LIMIT (a private const); kept in sync by hand.
const LIVE_SYNC_RESTART_LIMIT = 8;

/** Reach the engine's private change-path methods and state without widening its API. */
type EngineInternals = {
	handleLocalUpsert(file: TFile): Promise<void>;
	reconcile(): Promise<void>;
	reviveLiveSyncIfDead(): void;
	dropLiveSyncHandle(): void;
	startLiveSync(): void;
	initialIndexDone: boolean;
	liveSyncRestarts: number;
	syncHandler: unknown;
	lastHash: Map<string, string>;
	syncState: Map<string, SyncRecord>;
	db: { remote: unknown };
};
const priv = (): EngineInternals => engine as unknown as EngineInternals;

function setFile(path: string, text: string, mtime: number): void {
	const bytes = new TextEncoder().encode(text);
	files.set(path, { bytes, mtime, ctime: mtime, size: bytes.byteLength });
}

/** A real TFile instance (engine code guards on `instanceof TFile`) mirroring the map. */
function tfile(path: string): TFile {
	const e = files.get(path);
	if (!e) throw new Error(`no such fake file: ${path}`);
	const f = new TFile();
	Object.assign(f, { path, stat: { mtime: e.mtime, ctime: e.ctime, size: e.size } });
	return f;
}

function bodyOf(path: string): string {
	const e = files.get(path);
	if (!e) throw new Error(`no such fake file: ${path}`);
	return new TextDecoder().decode(e.bytes);
}

function makeApp() {
	const adapter = {
		async readBinary(p: string): Promise<ArrayBuffer> {
			const e = files.get(p);
			if (!e) throw Object.assign(new Error("not found"), { status: 404 });
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
			// writes the engine performs when materializing a pulled file:
			create: async (p: string, text: string) => {
				setFile(p, text, 5000);
				return tfile(p);
			},
			modify: async (f: TFile, text: string) => {
				setFile(f.path, text, 6000);
			},
			createBinary: async () => undefined,
			modifyBinary: async () => undefined,
			createFolder: async () => undefined,
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
	// reconcile sweep is allowed to run (it is gated until steady state).
	priv().initialIndexDone = true;
});

afterEach(async () => {
	engine.stop();
	await db.destroyLocal().catch(() => undefined);
});

describe("live-sync reconciliation sweep — push side", () => {
	it("pushes a change when the vault event IS delivered (fast path baseline)", async () => {
		setFile("note.md", "v1", 1000);
		await priv().handleLocalUpsert(tfile("note.md"));

		const doc = await getDoc("note.md");
		expect(doc?.deleted).toBe(false);
		expect(doc?.mtime).toBe(1000);
		expect(doc?.size).toBe(2);
	});

	it("reproduces the bug: a DROPPED modify event strands the edit, then the sweep heals it", async () => {
		setFile("note.md", "v1", 1000);
		await priv().handleLocalUpsert(tfile("note.md")); // first edit synced normally
		expect((await getDoc("note.md"))?.mtime).toBe(1000);

		// The user edits again, but the "modify" event never arrives (mobile suspend /
		// throttled timer / fired against a torn-down engine). Nothing pushes it.
		setFile("note.md", "v2 is longer", 2000);

		// Bug reproduced: the database still holds the stale version.
		const stale = await getDoc("note.md");
		expect(stale?.mtime).toBe(1000);
		expect(stale?.size).toBe(2);

		// The periodic sweep re-pushes it with no vault event at all.
		await priv().reconcile();

		const healed = await getDoc("note.md");
		expect(healed?.mtime).toBe(2000);
		expect(healed?.size).toBe("v2 is longer".length);
		expect(healed?.deleted).toBe(false);
	});

	it("reproduces the bug for a NEW file whose create event was dropped", async () => {
		setFile("fresh.md", "created on the phone", 1500);
		expect(await getDoc("fresh.md")).toBeNull();

		await priv().reconcile();

		const doc = await getDoc("fresh.md");
		expect(doc?.mtime).toBe(1500);
		expect(doc?.deleted).toBe(false);
	});

	it("tombstones a locally-deleted file whose delete event was missed", async () => {
		setFile("gone.md", "hello", 1000);
		await priv().handleLocalUpsert(tfile("gone.md"));
		expect((await getDoc("gone.md"))?.deleted).toBe(false);

		files.delete("gone.md"); // deleted on disk, delete event never delivered
		await priv().reconcile();

		expect((await getDoc("gone.md"))?.deleted).toBe(true);
	});
});

describe("live-sync reconciliation sweep — pull side (the desktop scenario)", () => {
	it("materializes a remote-only file to disk that the live feed left in the DB", async () => {
		// Arrange a file that exists in the local DB (as if the live pull replicated it
		// in from the phone) but was never written to this device's disk — the state a
		// desktop lands in when materialization is starved by its own upload work.
		setFile("from-phone.md", "made on the phone", 1000);
		await priv().handleLocalUpsert(tfile("from-phone.md")); // populate DB (doc + chunks)
		files.delete("from-phone.md"); // ...but this device has it only in the DB, not on disk
		priv().lastHash.clear(); // and has no memory of ever holding it (a fresh puller)
		priv().syncState.clear();

		expect(files.has("from-phone.md")).toBe(false); // not visible in the vault yet

		await priv().reconcile();

		// The sweep pulled it onto disk without any live-feed change event.
		expect(files.has("from-phone.md")).toBe(true);
		expect(bodyOf("from-phone.md")).toBe("made on the phone");
	});

	it("prioritizes pulling remote files ahead of pushing local backlog", async () => {
		// A remote-only file waiting in the DB...
		setFile("incoming.md", "priority from another device", 1000);
		await priv().handleLocalUpsert(tfile("incoming.md"));
		files.delete("incoming.md");
		priv().lastHash.clear();
		priv().syncState.clear();

		// ...alongside a large local backlog the events never pushed.
		for (let i = 0; i < 5; i++) setFile(`local-${i}.md`, `local backlog ${i}`, 2000 + i);

		await priv().reconcile();

		// The incoming file is on disk (pulled first) AND the backlog eventually pushed.
		expect(files.has("incoming.md")).toBe(true);
		for (let i = 0; i < 5; i++) expect(await getDoc(`local-${i}.md`)).toBeTruthy();
	});
});

describe("live-sync handle recovery (desktop dead-pull path)", () => {
	it("drops a dead handle: cancels it and clears the reference", () => {
		const p = priv();
		let cancelled = false;
		p.syncHandler = { cancel: () => (cancelled = true) };
		p.dropLiveSyncHandle();
		expect(cancelled).toBe(true);
		expect(p.syncHandler).toBe(null);
	});

	it("re-establishes the live feed once when it has died, and not while it is alive", () => {
		const p = priv();
		let starts = 0;
		p.startLiveSync = () => {
			starts++;
			p.syncHandler = { cancel: () => undefined }; // a handle that stays up
		};
		p.db.remote = {}; // something to bind to
		p.syncHandler = null; // the feed is dead

		p.reviveLiveSyncIfDead();
		expect(starts).toBe(1);
		expect(p.liveSyncRestarts).toBe(1);

		// alive again -> no further revive
		p.reviveLiveSyncIfDead();
		expect(starts).toBe(1);
	});

	it("stops re-establishing after the restart limit (a feed that keeps dying)", () => {
		const p = priv();
		let starts = 0;
		p.startLiveSync = () => {
			starts++; // handle dies immediately: leave syncHandler null
		};
		p.db.remote = {};
		p.syncHandler = null;

		for (let i = 0; i < LIVE_SYNC_RESTART_LIMIT + 10; i++) p.reviveLiveSyncIfDead();

		expect(starts).toBe(LIVE_SYNC_RESTART_LIMIT); // capped, then leaves the error standing
	});

	it("never binds when there is no remote to bind to", () => {
		const p = priv();
		let starts = 0;
		p.startLiveSync = () => starts++;
		p.db.remote = null;
		p.syncHandler = null;
		p.reviveLiveSyncIfDead();
		expect(starts).toBe(0);
	});
});

describe("live-sync reconciliation sweep — safety", () => {
	it("does not run before the initial index has settled (no race with startup)", async () => {
		priv().initialIndexDone = false; // engine still doing its initial pass
		setFile("early.md", "written during startup", 1200);

		await priv().reconcile();

		expect(await getDoc("early.md")).toBeNull();
	});

	it("is a no-op when nothing drifted (idempotent, no spurious writes)", async () => {
		setFile("stable.md", "unchanged", 1000);
		await priv().handleLocalUpsert(tfile("stable.md"));
		const before = await getDoc("stable.md");

		await priv().reconcile();
		await priv().reconcile();

		const after = await getDoc("stable.md");
		expect(after?._rev).toBe(before?._rev); // same revision — not rewritten
	});
});
