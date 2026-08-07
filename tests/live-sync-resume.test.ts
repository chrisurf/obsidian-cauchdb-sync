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
 * Regression: after the one-shot bulk actions "Download from server" and "Upload to
 * server", the engine was left INERT — no vault events, no live feed, no periodic
 * reconcile — while the status card still read "SYNC ON". A change made afterwards
 * then sat "on disk, not cached" and never propagated until the user pressed Force
 * sync. These tests drive the real one-shot entry points and prove that, once the
 * forced pass is done, the engine is watching again and a later edit still syncs.
 */

interface Entry { bytes: Uint8Array; mtime: number; ctime: number; size: number }
type ReconcileInternals = { reconcile(): Promise<void> };
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
			on: () => ({}), // a plausible EventRef; attachVaultEvents just collects them
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

/** Poll a condition to completion (the one-shot entry points wire up in a background task). */
async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
	const started = Date.now();
	while (!cond()) {
		if (Date.now() - started > ms) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 10));
	}
}

let device: Device;
let server: Device;

beforeEach(() => {
	device = makeDevice(`mem-resume-dev-${counter}`);
	server = makeDevice(`mem-resume-srv-${counter}`);
	counter++;
	// Point the device's remote at the server pouch for local↔local replication, without
	// touching a real URL (startDownloadOnly/startUploadOnly call connectRemote themselves).
	device.db.connectRemote = () => {
		device.db.remote = server.db.local;
		return server.db.local;
	};
});

afterEach(async () => {
	device.engine.stop();
	server.engine.stop();
	await device.db.destroyLocal().catch(() => undefined);
	await server.db.destroyLocal().catch(() => undefined);
});

async function seedServer(path: string, text: string, mtime: number): Promise<void> {
	setFile(server.files, path, text, mtime);
	await (server.engine as unknown as SeedInternals).handleLocalUpsert(tfile(server.files, path));
}

describe("live sync resumes after a one-shot bulk action", () => {
	it("keeps watching after Download from server, so a later local edit still propagates", async () => {
		await seedServer("seed.md", "from server", 1000);

		await device.engine.startDownloadOnly();
		// once the forced pass is done, the engine must be watching the vault again
		await waitFor(() => device.engine.getEventRefs().length > 0);
		expect(device.engine.getEventRefs().length).toBeGreaterThan(0);

		// a change made AFTER the download whose vault event is dropped (mobile suspend):
		// only the periodic reconcile can catch it — and only if live sync is still alive.
		setFile(device.files, "after-download.md", "edited after the download", 3000);
		await (device.engine as unknown as ReconcileInternals).reconcile();

		expect(await device.db.get(FILE_PREFIX + "after-download.md")).not.toBeNull();
	});

	it("keeps watching after Upload to server, so a later local edit still propagates", async () => {
		setFile(device.files, "local.md", "local content", 1000);

		await device.engine.startUploadOnly();
		await waitFor(() => device.engine.getEventRefs().length > 0);
		expect(device.engine.getEventRefs().length).toBeGreaterThan(0);

		setFile(device.files, "after-upload.md", "edited after the upload", 3000);
		await (device.engine as unknown as ReconcileInternals).reconcile();

		expect(await device.db.get(FILE_PREFIX + "after-upload.md")).not.toBeNull();
	});
});
