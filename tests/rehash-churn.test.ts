// @vitest-environment happy-dom
// pouchdb-browser touches browser globals at import time, so this suite runs under
// a lightweight DOM. The in-memory adapter needs no IndexedDB.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import PouchDB from "pouchdb-browser";
import memoryAdapter from "pouchdb-adapter-memory";
import { TFile } from "obsidian";
import { SyncEngine } from "../src/engine";
import { SyncDatabase } from "../src/database";
import { DEFAULT_SETTINGS, SYNC_STATE, type CouchDBSyncSettings, type SyncRecord, type SyncState } from "../src/types";

PouchDB.plugin(memoryAdapter);

/**
 * Regressions for "unchanged files keep re-entering sync". Two guarantees:
 *  - Fix 1: sync records survive into a fresh engine (flushState), so a restart /
 *    app-kill does not force a full re-hash of every file next launch.
 *  - Fix 3: re-hashing a touched-but-identical file is silent — it neither pushes
 *    nor lights the "Syncing" status.
 */

interface Entry { bytes: Uint8Array; mtime: number; ctime: number; size: number }

type Internals = {
	handleLocalUpsert(f: TFile): Promise<void>;
	indexLocalFiles(): Promise<void>;
	pushFile(f: TFile): Promise<boolean>;
	loadSyncState(): Promise<void>;
	isUnchanged(f: TFile): boolean;
	flushState(): Promise<void>;
	persistSyncState(force?: boolean): Promise<void>;
	bucketOf(p: string): number;
	syncState: Map<string, SyncRecord>;
	dirtyStateBuckets: Set<number>;
	aborted: boolean;
};
const pv = (e: SyncEngine) => e as unknown as Internals;

let counter = 0;
let db: SyncDatabase;
let engine: SyncEngine;
let files: Map<string, Entry>;
let readBinaryCalls: string[];
let statuses: SyncState[];
let settings: CouchDBSyncSettings;

function setFile(path: string, text: string, mtime: number): void {
	const bytes = new TextEncoder().encode(text);
	files.set(path, { bytes, mtime, ctime: mtime, size: bytes.byteLength });
}
function tfile(path: string): TFile {
	const e = files.get(path)!;
	const f = new TFile();
	Object.assign(f, { path, stat: { mtime: e.mtime, ctime: e.ctime, size: e.size } });
	return f;
}
function makeApp() {
	return {
		vault: {
			configDir: ".obsidian",
			on: () => ({}),
			offref: () => undefined,
			getFiles: () => [...files.keys()].map(tfile),
			getAbstractFileByPath: (p: string) => (files.has(p) ? tfile(p) : null),
			adapter: {
				async readBinary(p: string): Promise<ArrayBuffer> {
					readBinaryCalls.push(p);
					return files.get(p)!.bytes.slice().buffer;
				},
				async exists(p: string) { return files.has(p); },
				async stat(p: string) {
					const e = files.get(p);
					return e ? { type: "file" as const, mtime: e.mtime, ctime: e.ctime, size: e.size } : null;
				},
			},
		},
		fileManager: { trashFile: async () => undefined },
	};
}
function newEngine(): SyncEngine {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return new SyncEngine(makeApp() as any, db, settings, (s) => statuses.push(s));
}

beforeEach(() => {
	files = new Map();
	readBinaryCalls = [];
	statuses = [];
	settings = { ...DEFAULT_SETTINGS, e2eeEnabled: false, liveSync: true, deviceId: "d" };
	db = new SyncDatabase(settings, `mem-churn-${counter++}`, { adapter: "memory" });
	engine = newEngine();
});
afterEach(async () => { engine.stop(); await db.destroyLocal().catch(() => undefined); });

describe("Fix 1 — durable syncState survives a restart", () => {
	it("a fresh engine loads persisted records and does NOT re-hash the file", async () => {
		setFile("song.mp3", "PRETEND-LARGE-AUDIO", 1000);
		await pv(engine).handleLocalUpsert(tfile("song.mp3")); // first push persists the record
		const readsAfterFirst = readBinaryCalls.length;

		// Simulate a restart: a brand-new engine on the SAME database.
		const engine2 = newEngine();
		await pv(engine2).loadSyncState();

		expect(pv(engine2).isUnchanged(tfile("song.mp3"))).toBe(true);
		await pv(engine2).indexLocalFiles(); // would re-hash anything failing isUnchanged
		expect(readBinaryCalls.length).toBe(readsAfterFirst); // no extra read -> no re-hash
		engine2.stop();
	});

	it("flushState persists records even while aborting; the non-forced path does not", async () => {
		// Records produced late in a session, not yet written, while teardown is running.
		pv(engine).syncState.set("late.md", { mtime: 5, size: 9, hash: "h" });
		pv(engine).dirtyStateBuckets.add(pv(engine).bucketOf("late.md"));
		pv(engine).aborted = true;

		// The ordinary debounced write bails out while aborted...
		await pv(engine).persistSyncState();
		const noFlush = newEngine();
		await pv(noFlush).loadSyncState();
		expect(pv(noFlush).syncState.has("late.md")).toBe(false);
		noFlush.stop();

		// ...but the explicit flush writes it, so the next engine sees it.
		await pv(engine).flushState();
		const afterFlush = newEngine();
		await pv(afterFlush).loadSyncState();
		expect(pv(afterFlush).syncState.get("late.md")).toEqual({ mtime: 5, size: 9, hash: "h" });
		afterFlush.stop();
	});
});

describe("Fix 3 — re-verifying an unchanged file is silent", () => {
	it("pushFile returns false for an identical re-hash and true for a real change", async () => {
		setFile("f.md", "v1", 1000);
		expect(await pv(engine).pushFile(tfile("f.md"))).toBe(true); // first real push

		setFile("f.md", "v1", 2000); // mtime bumped, content identical
		expect(await pv(engine).pushFile(tfile("f.md"))).toBe(false); // adopted, nothing pushed

		setFile("f.md", "v2 different", 3000); // real content change
		expect(await pv(engine).pushFile(tfile("f.md"))).toBe(true);
	});

	it("an mtime-only re-hash does not light the Syncing status", async () => {
		setFile("song.mp3", "AUDIO-BYTES", 1000);
		await pv(engine).handleLocalUpsert(tfile("song.mp3"));
		statuses.length = 0;

		setFile("song.mp3", "AUDIO-BYTES", 2000); // touched, identical content
		await pv(engine).indexLocalFiles();

		expect(readBinaryCalls).toContain("song.mp3"); // it WAS re-read/verified...
		expect(statuses).not.toContain(SYNC_STATE.SYNCING); // ...but stayed quiet
	});

	it("a real content change still lights the Syncing status", async () => {
		setFile("song.mp3", "AUDIO-BYTES", 1000);
		await pv(engine).handleLocalUpsert(tfile("song.mp3"));
		statuses.length = 0;

		setFile("song.mp3", "DIFFERENT-AUDIO-BYTES", 2000);
		await pv(engine).indexLocalFiles();

		expect(statuses).toContain(SYNC_STATE.SYNCING);
	});
});
