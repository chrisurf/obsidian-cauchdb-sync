// @vitest-environment happy-dom
// pouchdb-browser touches browser globals at import time, so this suite runs under
// a lightweight DOM. The in-memory adapter needs no IndexedDB.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import PouchDB from "pouchdb-browser";
import memoryAdapter from "pouchdb-adapter-memory";
import { TFile } from "obsidian";
import { SyncEngine } from "../src/engine";
import { SyncDatabase } from "../src/database";
import { DEFAULT_SETTINGS, FILE_PREFIX, type CouchDBSyncSettings, type FileDoc } from "../src/types";

PouchDB.plugin(memoryAdapter);

/**
 * Regression: a file DELETED on the server (a tombstone) reached the local cache but
 * was never removed from this device's disk — it stayed "only on disk (not cached)".
 *
 * Two gaps caused it:
 *  - "Download from server" (server wins) skipped tombstones, so it pulled the delete
 *    into the cache but never applied it to disk.
 *  - Live sync had no self-heal for a remote deletion whose change-event was missed
 *    (mobile suspend), only for local ones — so the file lingered forever.
 *
 * These tests drive the real engine and prove the deletion now reaches disk, while a
 * local (re)creation on top of a tombstone is preserved.
 */

interface Entry { bytes: Uint8Array; mtime: number; ctime: number; size: number }
type Seed = { handleLocalUpsert(f: TFile): Promise<void>; handleLocalDelete(p: string): Promise<void> };
type DownloadInternals = { downloadOnce(): Promise<void> };
type ReconcileInternals = { reconcile(): Promise<void>; initialIndexDone: boolean };

let counter = 0;

interface Device {
	files: Map<string, Entry>;
	db: SyncDatabase;
	engine: SyncEngine;
}

function setFile(files: Map<string, Entry>, path: string, text: string, mtime: number): void {
	const bytes = new TextEncoder().encode(text);
	files.set(path, { bytes, mtime, ctime: mtime, size: bytes.byteLength });
}
function tfile(files: Map<string, Entry>, path: string): TFile {
	const e = files.get(path);
	if (!e) throw new Error(`no such fake file: ${path}`);
	const f = new TFile();
	Object.assign(f, { path, stat: { mtime: e.mtime, ctime: e.ctime, size: e.size } });
	return f;
}

function makeApp(files: Map<string, Entry>) {
	const adapter = {
		async readBinary(p: string): Promise<ArrayBuffer> {
			const e = files.get(p);
			if (!e) throw Object.assign(new Error("not found"), { status: 404 });
			return e.bytes.slice().buffer;
		},
		async exists(p: string): Promise<boolean> { return files.has(p); },
		async remove(p: string): Promise<void> { files.delete(p); },
		async stat(p: string) {
			const e = files.get(p);
			return e ? { type: "file" as const, mtime: e.mtime, ctime: e.ctime, size: e.size } : null;
		},
	};
	return {
		vault: {
			configDir: ".obsidian",
			on: () => ({}),
			offref: () => undefined,
			getFiles: () => [...files.keys()].map((p) => tfile(files, p)),
			getAbstractFileByPath: (p: string) => (files.has(p) ? tfile(files, p) : null),
			create: async (p: string, text: string) => { setFile(files, p, text, 5000); return tfile(files, p); },
			modify: async (f: TFile, text: string) => { setFile(files, f.path, text, 6000); },
			createBinary: async () => undefined,
			modifyBinary: async () => undefined,
			createFolder: async () => undefined,
			adapter,
		},
		// trashing a file removes it from the vault (what applyRemoteChange does on a delete)
		fileManager: { trashFile: async (f: TFile) => { files.delete(f.path); } },
	};
}

function makeDevice(name: string): Device {
	const files = new Map<string, Entry>();
	const settings: CouchDBSyncSettings = {
		...DEFAULT_SETTINGS,
		e2eeEnabled: false,
		liveSync: true,
		deviceId: name,
	};
	const db = new SyncDatabase(settings, name, { adapter: "memory" });
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const engine = new SyncEngine(makeApp(files) as any, db, settings, () => undefined);
	return { files, db, engine };
}

let device: Device;
let server: Device;

beforeEach(() => {
	device = makeDevice(`mem-del-dev-${counter}`);
	server = makeDevice(`mem-del-srv-${counter}`);
	counter++;
});

afterEach(async () => {
	device.engine.stop();
	server.engine.stop();
	await device.db.destroyLocal().catch(() => undefined);
	await server.db.destroyLocal().catch(() => undefined);
});

describe("Download from server propagates a server-side deletion to disk", () => {
	it("removes a file the server deleted, instead of leaving it 'only on disk'", async () => {
		// Server has the file; the device downloads it so both sides agree (one shared rev).
		setFile(server.files, "gone.md", "shared content", 1000);
		await (server.engine as unknown as Seed).handleLocalUpsert(tfile(server.files, "gone.md"));

		device.db.remote = server.db.local;
		await (device.engine as unknown as DownloadInternals).downloadOnce();
		expect(device.files.has("gone.md")).toBe(true); // pulled to disk

		// The file is deleted on the server (a tombstone), then the device downloads again.
		await (server.engine as unknown as Seed).handleLocalDelete("gone.md");
		await (device.engine as unknown as DownloadInternals).downloadOnce();

		// server-wins: the deletion reached disk, and the cache holds the tombstone
		expect(device.files.has("gone.md")).toBe(false);
		expect((await device.db.get(FILE_PREFIX + "gone.md"))?.deleted).toBe(true);
	});
});

describe("Live-sync reconcile heals a missed remote deletion", () => {
	/** Simulate a tombstone that replicated into the cache without being applied to disk. */
	async function tombstoneInCache(d: Device, path: string): Promise<void> {
		const doc = await d.db.get(FILE_PREFIX + path);
		if (!doc) throw new Error(`no cache doc for ${path}`);
		doc.deleted = true;
		doc._deleted = false; // logical delete: keep a tombstone document
		doc.children = [];
		doc.hash = "";
		await d.db.put(doc);
	}

	it("removes a disk file whose delete-event was missed (unchanged since we synced it)", async () => {
		setFile(device.files, "note.md", "content", 1000);
		await (device.engine as unknown as Seed).handleLocalUpsert(tfile(device.files, "note.md"));
		await tombstoneInCache(device, "note.md"); // delete pulled into cache, disk untouched

		(device.engine as unknown as ReconcileInternals).initialIndexDone = true;
		await (device.engine as unknown as ReconcileInternals).reconcile();

		expect(device.files.has("note.md")).toBe(false); // the sweep trashed it
	});

	it("keeps a locally re-created file rather than eating it (local creation beats the tombstone)", async () => {
		setFile(device.files, "kept.md", "original", 1000);
		await (device.engine as unknown as Seed).handleLocalUpsert(tfile(device.files, "kept.md"));
		await tombstoneInCache(device, "kept.md");

		// The user re-creates / edits the file locally AFTER the remote delete (new stat).
		setFile(device.files, "kept.md", "re-created locally, and longer", 5000);

		(device.engine as unknown as ReconcileInternals).initialIndexDone = true;
		await (device.engine as unknown as ReconcileInternals).reconcile();

		// the divergent local file survives ...
		expect(device.files.has("kept.md")).toBe(true);
		// ... and was resurrected in the cache (a new non-deleted revision on top of the tombstone)
		expect((await device.db.get(FILE_PREFIX + "kept.md"))?.deleted).toBe(false);
	});
});
