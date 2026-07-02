import { decryptString, encryptString, hmacPath } from "./crypto";
import {
	CouchDBSyncSettings,
	FILE_PREFIX,
	FileDoc,
	HISTORY_PREFIX,
	HISTORY_SEP,
	VersionDoc,
} from "./types";

/**
 * Metadata-private document envelope.
 *
 * When end-to-end encryption is active, a file/version document is stored and
 * replicated in an opaque WIRE form so the CouchDB server never sees plaintext
 * paths, sizes, timestamps, device ids, or the file→chunk mapping:
 *
 *   wire = { _id: "f:"+HMAC(path), type, enc, deleted, meta: <encrypted JSON> }
 *
 * - `_id` is a deterministic keyed hash of the path (same path+passphrase → same
 *   id on every device, so a shared doc — not duplicates — and conflicts still
 *   merge). The path is one-way here; the real path travels inside `meta`.
 * - `meta` is the AES-256-GCM encryption of every sensitive field.
 * - Only structural fields stay clear: `type` (needed for range filtering),
 *   `enc`, and `deleted` (tombstone flag).
 *
 * The rest of the plugin works exclusively with the decrypted ENGINE form (a plain
 * FileDoc/VersionDoc whose `_id` is the plaintext "f:"+path). `dehydrate*` converts
 * engine→wire on the way into the local DB; `hydrate*` converts wire→engine on the
 * way out. When encryption is off, both are (near) identity, preserving the legacy
 * plaintext format.
 */

/** Is metadata-private (paths + metadata) storage active? */
export function encActive(settings: CouchDBSyncSettings): boolean {
	return !!settings.e2eeEnabled && !!settings.passphrase;
}

interface FileMeta {
	path: string;
	mtime: number;
	ctime: number;
	size: number;
	deviceId: string;
	binary: boolean;
	children: string[];
	hash: string;
}

interface VersionMeta {
	path: string;
	mtime: number;
	size: number;
	hash: string;
	deviceId: string;
	binary: boolean;
	children: string[];
	deleted: boolean;
	note?: string;
}

/** Loose wire shape — a stored/replicated document that may or may not be encrypted. */
export type Wire = Record<string, unknown> & {
	_id: string;
	_rev?: string;
	_deleted?: boolean;
	_conflicts?: string[];
	type?: string;
	enc?: boolean;
	deleted?: boolean;
	meta?: string;
};

/**
 * Map a plaintext engine-space id to the id actually stored/replicated.
 *   "f:<path>"            → "f:<hmac(path)>"
 *   "H:<path>\n<ts>\n<h>" → "H:<hmac(path)>\n<ts>\n<h>"  (tail preserved for sorting)
 * Identity when encryption is off or the id is neither a file nor a history id.
 */
export async function toStoredId(id: string, settings: CouchDBSyncSettings): Promise<string> {
	if (!encActive(settings)) return id;
	const pass = settings.passphrase;
	if (id.startsWith(FILE_PREFIX)) {
		return FILE_PREFIX + (await hmacPath(id.slice(FILE_PREFIX.length), pass));
	}
	if (id.startsWith(HISTORY_PREFIX)) {
		const rest = id.slice(HISTORY_PREFIX.length);
		const sep = rest.indexOf(HISTORY_SEP);
		if (sep < 0) return id;
		const path = rest.slice(0, sep);
		const tail = rest.slice(sep); // includes the leading separator
		return HISTORY_PREFIX + (await hmacPath(path, pass)) + tail;
	}
	return id;
}

/** Lexicographic range base ("H:<key>\n") for one path's history, in stored-id space. */
export async function historyRangeBase(
	path: string,
	settings: CouchDBSyncSettings
): Promise<string> {
	const key = encActive(settings) ? await hmacPath(path, settings.passphrase) : path;
	return HISTORY_PREFIX + key + HISTORY_SEP;
}

// --- file documents --------------------------------------------------------

export async function dehydrateFile(doc: FileDoc, settings: CouchDBSyncSettings): Promise<Wire> {
	if (!encActive(settings)) {
		return { ...doc, _id: FILE_PREFIX + doc.path };
	}
	const pass = settings.passphrase;
	const meta: FileMeta = {
		path: doc.path,
		mtime: doc.mtime,
		ctime: doc.ctime,
		size: doc.size,
		deviceId: doc.deviceId,
		binary: doc.binary,
		children: doc.children,
		hash: doc.hash,
	};
	const wire: Wire = {
		_id: FILE_PREFIX + (await hmacPath(doc.path, pass)),
		type: "file",
		enc: doc.enc,
		deleted: doc.deleted,
		meta: await encryptString(JSON.stringify(meta), pass),
	};
	if (doc._rev) wire._rev = doc._rev;
	if (doc._deleted) wire._deleted = doc._deleted;
	return wire;
}

export async function hydrateFile(wire: Wire, settings: CouchDBSyncSettings): Promise<FileDoc> {
	if (typeof wire.meta !== "string") {
		// Plaintext / legacy document: normalize the id to the plaintext form.
		const d = wire as unknown as FileDoc;
		return { ...d, _id: FILE_PREFIX + d.path };
	}
	const pass = settings.passphrase;
	if (!pass) throw new Error("Encrypted document, but no passphrase is set.");
	const m: FileMeta = JSON.parse(await decryptString(wire.meta, pass));
	const doc: FileDoc = {
		_id: FILE_PREFIX + m.path,
		type: "file",
		path: m.path,
		mtime: m.mtime,
		ctime: m.ctime,
		size: m.size,
		deleted: !!wire.deleted,
		deviceId: m.deviceId,
		binary: m.binary,
		enc: !!wire.enc,
		children: m.children,
		hash: m.hash,
	};
	if (wire._rev) doc._rev = wire._rev;
	if (wire._deleted) doc._deleted = wire._deleted;
	if (wire._conflicts) doc._conflicts = wire._conflicts;
	return doc;
}

// --- version (history) documents -------------------------------------------

export async function dehydrateVersion(
	doc: VersionDoc,
	settings: CouchDBSyncSettings
): Promise<Wire> {
	if (!encActive(settings)) return { ...doc } as unknown as Wire;
	const pass = settings.passphrase;
	const meta: VersionMeta = {
		path: doc.path,
		mtime: doc.mtime,
		size: doc.size,
		hash: doc.hash,
		deviceId: doc.deviceId,
		binary: doc.binary,
		children: doc.children,
		deleted: doc.deleted,
		note: doc.note,
	};
	const wire: Wire = {
		_id: await toStoredId(doc._id, settings),
		type: "version",
		enc: doc.enc,
		ts: doc.ts, // already encoded (padded) in the id, so no extra leak; kept for sort
		meta: await encryptString(JSON.stringify(meta), pass),
	};
	if (doc._rev) wire._rev = doc._rev;
	if (doc._deleted) wire._deleted = doc._deleted;
	return wire;
}

export async function hydrateVersion(
	wire: Wire,
	settings: CouchDBSyncSettings
): Promise<VersionDoc> {
	if (typeof wire.meta !== "string") return wire as unknown as VersionDoc;
	const pass = settings.passphrase;
	if (!pass) throw new Error("Encrypted version doc, but no passphrase is set.");
	const m: VersionMeta = JSON.parse(await decryptString(wire.meta, pass));
	// Rebuild the plaintext id by swapping the hashed path back for the real path,
	// preserving the "\n<ts>\n<hash>" tail exactly as stored.
	const rest = wire._id.slice(HISTORY_PREFIX.length);
	const sep = rest.indexOf(HISTORY_SEP);
	const tail = sep >= 0 ? rest.slice(sep) : "";
	const doc: VersionDoc = {
		_id: HISTORY_PREFIX + m.path + tail,
		type: "version",
		path: m.path,
		ts: typeof wire.ts === "number" ? wire.ts : 0,
		mtime: m.mtime,
		size: m.size,
		hash: m.hash,
		deviceId: m.deviceId,
		binary: m.binary,
		enc: !!wire.enc,
		children: m.children,
		deleted: m.deleted,
		note: m.note,
	};
	if (wire._rev) doc._rev = wire._rev;
	return doc;
}
