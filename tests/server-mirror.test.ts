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
 * The two bulk "make one side win" actions, proven against a REAL second PouchDB
 * standing in for the server (local↔local replication with the in-memory adapter):
 *
 * - Download from server  (server → this device): every server file is written to
 *   disk, overwriting a differing local copy; local-only files are left in place and
 *   nothing is uploaded.
 * - Upload to server       (this device → server): every local file overwrites the
 *   server's version; server-only files are left in place and disk is not touched.
 *
 * Each test seeds the "server" by pushing files through a second engine whose local
 * database IS the server pouch, then points the device engine's `remote` at it and
 * drives the real download/upload pass.
 */

interface Entry { bytes: Uint8Array; mtime: number; ctime: number; size: number }

type DownloadInternals = { downloadOnce(): Promise<void> };
type UploadInternals = { uploadOnce(): Promise<void> };
type SeedInternals = { handleLocalUpsert(f: TFile): Promise<void> };

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
function bodyOf(files: Map<string, Entry>, path: string): string {
	const e = files.get(path);
	if (!e) throw new Error(`no such fake file: ${path}`);
	return new TextDecoder().decode(e.bytes);
}

/** A writable fake vault backed by `files`, providing exactly what the engine touches. */
function makeApp(files: Map<string, Entry>) {
	const adapter = {
		async readBinary(p: string): Promise<ArrayBuffer> {
			const e = files.get(p);
			if (!e) throw Object.assign(new Error("not found"), { status: 404 });
			return e.bytes.slice().buffer;
		},
		async exists(p: string): Promise<boolean> { return files.has(p); },
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
		fileManager: { trashFile: async () => undefined },
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
	device = makeDevice(`mem-mirror-dev-${counter}`);
	server = makeDevice(`mem-mirror-srv-${counter}`);
	counter++;
});

afterEach(async () => {
	device.engine.stop();
	server.engine.stop();
	await device.db.destroyLocal().catch(() => undefined);
	await server.db.destroyLocal().catch(() => undefined);
});

/** Push a file into the "server" (its local pouch), the way another device would. */
async function seedServer(path: string, text: string, mtime: number): Promise<void> {
	setFile(server.files, path, text, mtime);
	await (server.engine as unknown as SeedInternals).handleLocalUpsert(tfile(server.files, path));
}

describe("Download from server — server wins, uploads nothing", () => {
	it("materializes remote-only files, overwrites a differing local file, keeps local-only files, uploads nothing", async () => {
		// The server holds two files, one of which also exists locally with OTHER content.
		await seedServer("notes/from-server.md", "SERVER VERSION", 1000);
		await seedServer("shared.md", "SERVER WINS", 1000);

		// On disk: a stale/divergent copy of shared.md, plus a file the server never saw.
		setFile(device.files, "shared.md", "old local text that must be replaced", 2000);
		setFile(device.files, "device-only.md", "only on this device", 2000);

		// Point the device's replication target at the server pouch and run download-only.
		device.db.remote = server.db.local;
		await (device.engine as unknown as DownloadInternals).downloadOnce();

		// remote-only file is now on disk with the server's content
		expect(device.files.has("notes/from-server.md")).toBe(true);
		expect(bodyOf(device.files, "notes/from-server.md")).toBe("SERVER VERSION");

		// the divergent local file was OVERWRITTEN with the server version
		expect(bodyOf(device.files, "shared.md")).toBe("SERVER WINS");

		// the local-only file is left in place (download does not delete extras) ...
		expect(bodyOf(device.files, "device-only.md")).toBe("only on this device");
		// ... and was NOT uploaded (download uploads nothing)
		expect(await server.db.get(FILE_PREFIX + "device-only.md")).toBeNull();
	});

	it("preserves an un-synced local edit to history before the server overwrites it", async () => {
		await seedServer("keep.md", "SERVER TEXT", 1000);
		setFile(device.files, "keep.md", "a local edit that was never pushed", 3000);

		device.db.remote = server.db.local;
		await (device.engine as unknown as DownloadInternals).downloadOnce();

		// server content won on disk
		expect(bodyOf(device.files, "keep.md")).toBe("SERVER TEXT");
		// but the overwritten local text is recoverable from history
		const versions = await device.engine.listHistory("keep.md");
		const texts = await Promise.all(versions.map((v) => device.engine.getVersionText(v)));
		expect(texts).toContain("a local edit that was never pushed");
	});
});

describe("Upload to server — local wins, deletes nothing on the server", () => {
	it("overwrites the server's version of every local file, adds local-only files, keeps server-only files, leaves disk untouched", async () => {
		// The server holds a divergent copy of shared.md and a file this device never had.
		await seedServer("shared.md", "the server's stale copy", 1000);
		await seedServer("only-on-server.md", "lives only on the server", 1000);

		// On disk: the copy we trust, plus a brand-new local file the server never saw.
		setFile(device.files, "shared.md", "LOCAL WINS", 2000);
		setFile(device.files, "notes/fresh-local.md", "brand new here", 2000);

		device.db.remote = server.db.local;
		await (device.engine as unknown as UploadInternals).uploadOnce();

		// the server's divergent file was OVERWRITTEN with this device's version ...
		expect(await server.engine.getRemoteText("shared.md")).toBe("LOCAL WINS");
		// ... the local-only file was added to the server ...
		expect(await server.engine.getRemoteText("notes/fresh-local.md")).toBe("brand new here");
		// ... and the server-only file was left in place (upload does not delete extras)
		expect(await server.engine.getRemoteText("only-on-server.md")).toBe("lives only on the server");

		// disk is untouched: local content unchanged, server-only file NOT downloaded
		expect(bodyOf(device.files, "shared.md")).toBe("LOCAL WINS");
		expect(device.files.has("only-on-server.md")).toBe(false);
	});

	it("is a clean no-op when the server already matches (identical content is adopted, not re-pushed)", async () => {
		await seedServer("same.md", "identical everywhere", 1000);
		const before = (await server.db.get(FILE_PREFIX + "same.md"))!._rev;

		// this device holds byte-identical content
		setFile(device.files, "same.md", "identical everywhere", 2000);

		device.db.remote = server.db.local;
		await (device.engine as unknown as UploadInternals).uploadOnce();

		// no new revision was written for content that already matched
		expect((await server.db.get(FILE_PREFIX + "same.md"))!._rev).toBe(before);
		expect(await server.engine.getRemoteText("same.md")).toBe("identical everywhere");
	});
});
