// @vitest-environment happy-dom
// pouchdb-browser touches browser globals at import time, so this suite runs under
// a lightweight DOM. The in-memory adapter needs no IndexedDB.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import PouchDB from "pouchdb-browser";
import memoryAdapter from "pouchdb-adapter-memory";
import { buildIndexReport } from "../src/engine";
import { SyncDatabase } from "../src/database";
import { DEFAULT_SETTINGS, type CouchDBSyncSettings, type FileDoc } from "../src/types";

PouchDB.plugin(memoryAdapter);

/**
 * Regression for the "Show hidden files" toggle. Flipping it used to re-fetch the whole
 * index report (a full database scan + per-doc decrypt) even though showExcluded is a
 * pure DISPLAY filter — the report does not depend on it. These tests pin that: the
 * report is byte-for-byte identical whether showExcluded is on or off, so the panel is
 * right to re-render the cached report instead of paying for a rescan on every toggle.
 */

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

/** Minimal app: buildIndexReport reads vault.getFiles().path, adapter, and configDir. */
function makeApp(vaultPaths: string[]) {
	return {
		vault: {
			configDir: ".obsidian",
			getFiles: () => vaultPaths.map((path) => ({ path })),
			adapter: {},
		},
	};
}

beforeEach(() => {
	db = new SyncDatabase({ ...DEFAULT_SETTINGS }, `mem-report-${counter++}`, { adapter: "memory" });
});

afterEach(async () => {
	await db.destroyLocal().catch(() => undefined);
});

describe("buildIndexReport is independent of the showExcluded display flag", () => {
	it("returns an identical report whether showExcluded is on or off", async () => {
		// A normal, in-sync file plus a hidden doc the skip rules exclude (hidden sync off).
		await db.put(fileDoc("note.md", { hash: "abc" }));
		await db.put(fileDoc(".obsidian/app.json", { hash: "hidden" }));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const app = makeApp(["note.md"]) as any;

		const base: CouchDBSyncSettings = { ...DEFAULT_SETTINGS, syncHidden: false };
		const off = await buildIndexReport(app, { ...base, showExcluded: false }, db);
		const on = await buildIndexReport(app, { ...base, showExcluded: true }, db);

		// The hidden file is reported as excluded regardless of the display flag...
		expect(off.excluded).toContain(".obsidian/app.json");
		// ...and nothing else about the report changes when the flag flips.
		expect(JSON.stringify(on)).toBe(JSON.stringify(off));
	});

	it("keeps the excluded file out of the syncable counts either way", async () => {
		await db.put(fileDoc("note.md", { hash: "abc" }));
		await db.put(fileDoc(".obsidian/app.json", { hash: "hidden" }));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const app = makeApp(["note.md"]) as any;
		const settings: CouchDBSyncSettings = { ...DEFAULT_SETTINGS, syncHidden: false, showExcluded: true };

		const report = await buildIndexReport(app, settings, db);

		// dbCount counts only non-skipped docs — the hidden one is not among them.
		expect(report.dbCount).toBe(1);
		expect(report.excluded).toEqual([".obsidian/app.json"]);
	});
});
