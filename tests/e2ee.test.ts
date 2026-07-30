// @vitest-environment happy-dom
// End-to-end encryption of metadata: with encryption on, the stored/replicated
// documents must expose NO plaintext path, size, timestamp, device id, or
// file→chunk mapping — while the engine still sees fully decrypted docs.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import PouchDB from "pouchdb-browser";
import memoryAdapter from "pouchdb-adapter-memory";
import { SyncDatabase } from "../src/database";
import { DEFAULT_SETTINGS, FileDoc, VersionDoc } from "../src/types";
import {
	dehydrateFile,
	historyRangeBase,
	hydrateFile,
	toStoredId,
} from "../src/envelope";
import { hmacPath } from "../src/crypto";

PouchDB.plugin(memoryAdapter);

const PASS = "correct-horse-battery-staple";
const encSettings = { ...DEFAULT_SETTINGS, e2eeEnabled: true, passphrase: PASS };

let counter = 0;
let db: SyncDatabase;

function fileDoc(path: string, over: Partial<FileDoc> = {}): FileDoc {
	return {
		_id: "f:" + path,
		type: "file",
		path,
		mtime: 1717000000000,
		ctime: 1717000000000,
		size: 4242,
		deleted: false,
		deviceId: "device-alpha",
		binary: false,
		enc: true,
		children: ["h:chunkone", "h:chunktwo"],
		hash: "deadbeef",
		...over,
	};
}

function versionDoc(path: string, over: Partial<VersionDoc> = {}): VersionDoc {
	return {
		_id: `H:${path}\n000001717000000\ndeadbeef`,
		type: "version",
		path,
		ts: 1717000000,
		mtime: 1717000000000,
		size: 4242,
		hash: "deadbeef",
		deviceId: "device-alpha",
		binary: false,
		enc: true,
		children: ["h:chunkone"],
		deleted: false,
		...over,
	};
}

beforeEach(() => {
	db = new SyncDatabase({ ...encSettings }, `mem-e2ee-${counter++}`, { adapter: "memory" });
});
afterEach(async () => {
	await db.destroyLocal().catch(() => undefined);
});

describe("E2EE envelope — engine ⇄ wire round-trip", () => {
	it("round-trips a file doc: engine sees plaintext, id is the plaintext path", async () => {
		const SECRET = "Journal/Very Secret Diary.md";
		await db.put(fileDoc(SECRET));

		const all = await db.getAll();
		expect(all).toHaveLength(1);
		const got = all[0];
		expect(got._id).toBe("f:" + SECRET);
		expect(got.path).toBe(SECRET);
		expect(got.size).toBe(4242);
		expect(got.deviceId).toBe("device-alpha");
		expect(got.children).toEqual(["h:chunkone", "h:chunktwo"]);
		expect(got.hash).toBe("deadbeef");
	});

	it("get() reverse-maps a plaintext id to the stored hashed id", async () => {
		const SECRET = "Notes/passwords.md";
		await db.put(fileDoc(SECRET));
		const got = await db.get("f:" + SECRET);
		expect(got).not.toBeNull();
		expect(got?.path).toBe(SECRET);
	});
});

describe("E2EE envelope — the server sees no plaintext", () => {
	it("the stored wire doc leaks neither the path nor the metadata", async () => {
		const SECRET = "Clients/Acme Corp/contract.md";
		await db.put(fileDoc(SECRET, { deviceId: "device-secret-name" }));

		// Inspect the RAW stored document (what replicates to CouchDB).
		const res = await (db.local as unknown as PouchDB.Database).allDocs({
			include_docs: true,
			startkey: "f:",
			endkey: "f:￿",
		});
		expect(res.rows).toHaveLength(1);
		const raw = res.rows[0].doc as Record<string, unknown>;

		// The id is a hashed path, not the plaintext one.
		expect(raw._id).toBe("f:" + (await hmacPath(SECRET, PASS)));
		expect(String(raw._id)).not.toContain("Acme");

		// Only structural fields are clear; everything sensitive is in `meta`.
		expect(raw.path).toBeUndefined();
		expect(raw.size).toBeUndefined();
		expect(raw.mtime).toBeUndefined();
		expect(raw.deviceId).toBeUndefined();
		expect(raw.children).toBeUndefined();
		expect(typeof raw.meta).toBe("string");
		expect(raw.type).toBe("file");

		// Nothing sensitive survives anywhere in the serialized wire doc.
		const blob = JSON.stringify(raw);
		expect(blob).not.toContain("Acme");
		expect(blob).not.toContain("contract");
		expect(blob).not.toContain("device-secret-name");
		expect(blob).not.toContain("deadbeef");
	});

	it("history docs also store a hashed id and no plaintext path", async () => {
		const SECRET = "Private/therapy-notes.md";
		await db.putVersionIfAbsent(versionDoc(SECRET));

		const res = await (db.local as unknown as PouchDB.Database).allDocs({
			include_docs: true,
			startkey: "H:",
			endkey: "H:￿",
		});
		expect(res.rows).toHaveLength(1);
		const raw = res.rows[0].doc as Record<string, unknown>;
		expect(String(raw._id)).not.toContain("therapy");
		expect(raw.path).toBeUndefined();
		expect(typeof raw.meta).toBe("string");

		// ...but listVersions decrypts it back for the app.
		const vers = await db.listVersions(SECRET);
		expect(vers).toHaveLength(1);
		expect(vers[0].path).toBe(SECRET);
		expect(vers[0].hash).toBe("deadbeef");
	});
});

describe("E2EE envelope — determinism & range integrity", () => {
	it("same path → same stored id (so two devices share one doc, not duplicates)", async () => {
		const a = await hmacPath("A/b/c.md", PASS);
		const b = await hmacPath("A/b/c.md", PASS);
		expect(a).toBe(b);
		expect(a).toHaveLength(64); // SHA-256 hex

		// writing the same path twice collapses to a single doc
		await db.put(fileDoc("A/b/c.md"));
		await db.put(fileDoc("A/b/c.md", { size: 9999 }));
		const all = await db.getAll();
		expect(all).toHaveLength(1);
		expect(all[0].size).toBe(9999);
	});

	it("a different passphrase yields a completely different id", async () => {
		const a = await hmacPath("same/path.md", PASS);
		const b = await hmacPath("same/path.md", "a-different-passphrase");
		expect(a).not.toBe(b);
	});

	it("getAll still range-scans correctly with hashed ids and excludes chunks", async () => {
		await db.put(fileDoc("one.md"));
		await db.put(fileDoc("two.md"));
		await db.putChunkIfAbsent("h:chunkone", true, new Uint8Array([1, 2, 3]));
		const all = await db.getAll();
		expect(all.map((d) => d.path).sort()).toEqual(["one.md", "two.md"]);
	});
});

describe("E2EE envelope — pure functions & failure modes", () => {
	it("dehydrate → hydrate is a faithful round-trip", async () => {
		const original = fileDoc("Roundtrip/file.md", { _rev: "1-abc" });
		const wire = await dehydrateFile(original, encSettings);
		const back = await hydrateFile(wire, encSettings);
		expect(back).toMatchObject({
			path: "Roundtrip/file.md",
			size: 4242,
			deviceId: "device-alpha",
			children: ["h:chunkone", "h:chunktwo"],
			hash: "deadbeef",
			_rev: "1-abc",
		});
	});

	it("a wrong passphrase cannot decrypt the doc", async () => {
		const wire = await dehydrateFile(fileDoc("x.md"), encSettings);
		await expect(
			hydrateFile(wire, { ...DEFAULT_SETTINGS, e2eeEnabled: true, passphrase: "wrong" })
		).rejects.toThrow();
	});

	it("toStoredId / historyRangeBase are identity when encryption is off", async () => {
		const off = { ...DEFAULT_SETTINGS, e2eeEnabled: false, passphrase: "" };
		expect(await toStoredId("f:a.md", off)).toBe("f:a.md");
		expect(await historyRangeBase("a.md", off)).toBe("H:a.md\n");
	});

	it("with encryption off, the doc is stored in legacy plaintext form", async () => {
		const plainDb = new SyncDatabase(
			{ ...DEFAULT_SETTINGS, e2eeEnabled: false, passphrase: "" },
			`mem-plain-${counter++}`,
			{ adapter: "memory" }
		);
		try {
			await plainDb.put(fileDoc("plain.md", { enc: false }));
			const raw = (await (plainDb.local as unknown as PouchDB.Database).get(
				"f:plain.md"
			)) as Record<string, unknown>;
			expect(raw.path).toBe("plain.md"); // plaintext, legacy format
			expect(raw.meta).toBeUndefined();
		} finally {
			await plainDb.destroyLocal().catch(() => undefined);
		}
	});
});
