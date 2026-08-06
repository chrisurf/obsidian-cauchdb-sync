// @vitest-environment happy-dom
// pouchdb-browser touches browser globals at import time, so this suite runs under
// a lightweight DOM. The in-memory adapter needs no IndexedDB.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import PouchDB from "pouchdb-browser";
import memoryAdapter from "pouchdb-adapter-memory";
import { TFile } from "obsidian";
import { SyncEngine } from "../src/engine";
import { SyncDatabase } from "../src/database";
import { DEFAULT_SETTINGS, FILE_PREFIX, type CouchDBSyncSettings, type FileDoc, type SyncRecord } from "../src/types";

PouchDB.plugin(memoryAdapter);

/**
 * "Force sync is the one button that makes everything consistent." Force sync maps to
 * restartSync -> doRestart -> engine.start() -> runInitialIndex(). This proves that one
 * pass converges BOTH directions: it uploads files the server does not have yet and
 * downloads files that live only in the database — exactly the mental model.
 */

interface Entry { bytes: Uint8Array; mtime: number; ctime: number; size: number }
type Internals = {
	handleLocalUpsert(f: TFile): Promise<void>;
	runInitialIndex(): Promise<void>;
	lastHash: Map<string, string>;
	syncState: Map<string, SyncRecord>;
};
const pv = (e: SyncEngine) => e as unknown as Internals;

let counter = 0;
let db: SyncDatabase;
let engine: SyncEngine;
let files: Map<string, Entry>;
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
function bodyOf(path: string): string {
	return new TextDecoder().decode(files.get(path)!.bytes);
}
function makeApp() {
	return {
		vault: {
			configDir: ".obsidian",
			on: () => ({}),
			offref: () => undefined,
			getFiles: () => [...files.keys()].map(tfile),
			getAbstractFileByPath: (p: string) => (files.has(p) ? tfile(p) : null),
			create: async (p: string, text: string) => { setFile(p, text, 5000); return tfile(p); },
			modify: async (f: TFile, text: string) => { setFile(f.path, text, 6000); },
			createBinary: async () => undefined,
			modifyBinary: async () => undefined,
			createFolder: async () => undefined,
			adapter: {
				async readBinary(p: string): Promise<ArrayBuffer> { return files.get(p)!.bytes.slice().buffer; },
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
const getDoc = (p: string): Promise<FileDoc | null> => db.get(FILE_PREFIX + p);

beforeEach(() => {
	files = new Map();
	settings = { ...DEFAULT_SETTINGS, e2eeEnabled: false, liveSync: true, deviceId: "d" };
	db = new SyncDatabase(settings, `mem-force-${counter++}`, { adapter: "memory" });
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	engine = new SyncEngine(makeApp() as any, db, settings, () => undefined);
});
afterEach(async () => { engine.stop(); await db.destroyLocal().catch(() => undefined); });

describe("Force sync — one pass converges both directions", () => {
	it("uploads local-only files AND downloads remote-only files", async () => {
		// A file that exists in the DB but not on this disk (as if another device made it).
		setFile("from-server.md", "made on another device", 1000);
		await pv(engine).handleLocalUpsert(tfile("from-server.md")); // populate DB (doc + chunks)
		files.delete("from-server.md"); // this device does not have it on disk
		pv(engine).lastHash.clear(); // ...and has no memory of it (a fresh cache, e.g. post-wipe)
		pv(engine).syncState.clear();

		// A file that lives only on this device — the server has never seen it.
		setFile("only-local.md", "brand new local note", 2000);

		expect(await getDoc("only-local.md")).toBeNull(); // not uploaded yet
		expect(files.has("from-server.md")).toBe(false); // not downloaded yet

		// Force sync == the initial-index pass restartSync/start kicks off.
		await pv(engine).runInitialIndex();

		// UPLOAD half: the local-only file is now in the database.
		const uploaded = await getDoc("only-local.md");
		expect(uploaded?.deleted).toBe(false);
		expect(uploaded?.size).toBe("brand new local note".length);

		// DOWNLOAD half: the remote-only file is now on disk with its content.
		expect(files.has("from-server.md")).toBe(true);
		expect(bodyOf("from-server.md")).toBe("made on another device");
	});

	it("is a clean no-op when everything already matches (idempotent)", async () => {
		setFile("a.md", "stable", 1000);
		await pv(engine).handleLocalUpsert(tfile("a.md"));
		const rev = (await getDoc("a.md"))!._rev;

		await pv(engine).runInitialIndex(); // second Force sync
		await pv(engine).runInitialIndex(); // third

		expect((await getDoc("a.md"))!._rev).toBe(rev); // no churn, no new revision
	});
});
