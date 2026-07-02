import { requestUrl, RequestUrlParam } from "obsidian";
import PouchDB from "pouchdb-browser";
import {
	CHUNK_ATTACHMENT,
	CouchDBSyncSettings,
	FileDoc,
	FILE_PREFIX,
	VersionDoc,
} from "./types";
import {
	Wire,
	dehydrateFile,
	dehydrateVersion,
	historyRangeBase,
	hydrateFile,
	hydrateVersion,
	toStoredId,
} from "./envelope";
import { base64ToUint8, uint8ToBase64 } from "./util";

const RANGE_END = "￿";

/** A chunk's decrypted-or-raw bytes plus whether they are encrypted. */
export interface ChunkBytes {
	enc: boolean;
	bytes: Uint8Array;
}

/** Normalize whatever PouchDB.getAttachment returns (Blob / Buffer / base64) to bytes. */
async function attachmentToBytes(x: unknown): Promise<Uint8Array> {
	if (x instanceof Uint8Array) return x; // node Buffer is a Uint8Array subclass
	if (x instanceof ArrayBuffer) return new Uint8Array(x);
	if (x && typeof (x as Blob).arrayBuffer === "function") {
		return new Uint8Array(await (x as Blob).arrayBuffer());
	}
	if (typeof x === "string") return base64ToUint8(x); // base64 fallback
	throw new Error("unexpected attachment payload type");
}

/**
 * A fetch() implementation backed by Obsidian's requestUrl(). This bypasses the
 * browser/WebView CORS layer entirely, which removes the single biggest source of
 * "works in the browser but not in the app" failures (especially on mobile).
 */
function obsidianFetch(): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input.toString();

		const headers: Record<string, string> = {};
		if (init?.headers) {
			if (init.headers instanceof Headers) {
				init.headers.forEach((v, k) => (headers[k] = v));
			} else if (Array.isArray(init.headers)) {
				for (const [k, v] of init.headers) headers[k] = v;
			} else {
				Object.assign(headers, init.headers);
			}
		}

		const param: RequestUrlParam = {
			url,
			method: init?.method ?? "GET",
			headers,
			throw: false, // let PouchDB interpret 404/409/etc. itself
		};
		if (init?.body != null) {
			param.body = init.body as string | ArrayBuffer;
		}

		const res = await requestUrl(param);
		const body =
			res.arrayBuffer && res.arrayBuffer.byteLength > 0 ? res.arrayBuffer : res.text;
		return new Response(body, {
			status: res.status,
			headers: res.headers as Record<string, string>,
		});
	}) as typeof fetch;
}

export class SyncDatabase {
	local: PouchDB.Database<FileDoc>;
	remote: PouchDB.Database<FileDoc> | null = null;
	private settings: CouchDBSyncSettings;

	constructor(
		settings: CouchDBSyncSettings,
		localName: string,
		localOptions?: PouchDB.Configuration.LocalDatabaseConfiguration
	) {
		this.settings = settings;
		// localOptions lets tests swap in the in-memory adapter; production passes none.
		this.local = new PouchDB<FileDoc>(localName, { auto_compaction: true, ...localOptions });
	}

	private remoteUrl(): string {
		const base = this.settings.serverUrl.replace(/\/+$/, "");
		return `${base}/${encodeURIComponent(this.settings.dbName)}`;
	}

	connectRemote(): PouchDB.Database<FileDoc> {
		this.remote = new PouchDB<FileDoc>(this.remoteUrl(), {
			auth: { username: this.settings.username, password: this.settings.password },
			fetch: obsidianFetch(),
			skip_setup: true,
		} as PouchDB.Configuration.RemoteDatabaseConfiguration);
		return this.remote;
	}

	/** Verify credentials + reachability. Returns a human-readable result. */
	async testConnection(): Promise<{ ok: boolean; message: string }> {
		try {
			const r = this.connectRemote();
			const info = await r.info();
			return {
				ok: true,
				message: `Connected to "${info.db_name}" (${info.doc_count} docs).`,
			};
		} catch (e: unknown) {
			const err = e as { status?: number; message?: string; name?: string };
			if (err.status === 401) return { ok: false, message: "Authentication failed (401). Check user/password." };
			if (err.status === 404) return { ok: false, message: "Database not found (404). Check the database name." };
			return { ok: false, message: `Connection failed: ${err.message ?? err.name ?? "unknown error"}` };
		}
	}

	async getAll(): Promise<FileDoc[]> {
		// Range query over file docs ONLY ("f:".."f:￿") so chunk docs are never
		// loaded into memory — that is what caused the out-of-memory crashes. We pull
		// `conflicts:true` in the SAME scan so the index report gets conflict info for
		// free (no second pass). The HMAC-based ids still sort under "f:", so the
		// range is unchanged. Each doc is hydrated (decrypted) back to engine form.
		const res = await this.local.allDocs({
			include_docs: true,
			conflicts: true,
			startkey: FILE_PREFIX,
			endkey: FILE_PREFIX + RANGE_END,
		});
		const out: FileDoc[] = [];
		for (const row of res.rows) {
			const d = row.doc as unknown as Wire | undefined;
			if (!d || d.type !== "file") continue;
			try {
				out.push(await hydrateFile(d, this.settings));
			} catch (e) {
				console.error("[couchdb-sync] cannot decrypt file doc", d._id, e);
			}
		}
		return out;
	}

	async get(id: string): Promise<FileDoc | null> {
		try {
			const raw = await this.local.get(await toStoredId(id, this.settings), {
				conflicts: true,
			});
			return await hydrateFile(raw as unknown as Wire, this.settings);
		} catch (e) {
			const err = e as { status?: number };
			if (err.status === 404) return null;
			throw e;
		}
	}

	async put(doc: FileDoc): Promise<void> {
		const wire = await dehydrateFile(doc, this.settings);
		try {
			const existing = await this.local.get(wire._id);
			wire._rev = (existing as { _rev?: string })._rev;
		} catch (e) {
			if ((e as { status?: number }).status !== 404) throw e;
		}
		await this.local.put(wire as unknown as FileDoc);
	}

	/** File documents that currently have unresolved conflict revisions. */
	async getConflicted(): Promise<FileDoc[]> {
		// File docs only (chunks are immutable and never conflict); range-bounded so
		// we never pull chunk data into memory.
		const res = await this.local.allDocs({
			include_docs: true,
			conflicts: true,
			startkey: FILE_PREFIX,
			endkey: FILE_PREFIX + RANGE_END,
		});
		const out: FileDoc[] = [];
		for (const row of res.rows) {
			const d = row.doc as unknown as Wire | undefined;
			if (d && d.type === "file" && Array.isArray(d._conflicts) && d._conflicts.length > 0) {
				try {
					out.push(await hydrateFile(d, this.settings));
				} catch (e) {
					console.error("[couchdb-sync] cannot decrypt conflicted doc", d._id, e);
				}
			}
		}
		return out;
	}

	async getRev(id: string, rev: string): Promise<FileDoc> {
		const raw = await this.local.get(await toStoredId(id, this.settings), { rev });
		return hydrateFile(raw as unknown as Wire, this.settings);
	}

	// --- explicit per-file version history ---------------------------------

	/** All history entries for a path, oldest → newest (chronological). */
	async listVersions(path: string): Promise<VersionDoc[]> {
		const base = await historyRangeBase(path, this.settings);
		const res = await this.local.allDocs({
			include_docs: true,
			startkey: base,
			endkey: base + RANGE_END,
		});
		const out: VersionDoc[] = [];
		for (const row of res.rows) {
			const d = row.doc as unknown as Wire | undefined;
			if (d && d.type === "version") {
				try {
					out.push(await hydrateVersion(d, this.settings));
				} catch (e) {
					console.error("[couchdb-sync] cannot decrypt version doc", d._id, e);
				}
			}
		}
		return out;
	}

	/** Append a version entry (idempotent: ignores a same-id duplicate). */
	async putVersionIfAbsent(doc: VersionDoc): Promise<void> {
		const wire = await dehydrateVersion(doc, this.settings);
		const db = this.local as unknown as PouchDB.Database;
		try {
			await db.get(wire._id);
			return; // already recorded
		} catch (e) {
			if ((e as { status?: number }).status !== 404) throw e;
		}
		try {
			await db.put(wire);
		} catch (e) {
			if ((e as { status?: number }).status !== 409) throw e; // raced
		}
	}

	async removeVersion(id: string, rev: string): Promise<void> {
		await this.local.remove(await toStoredId(id, this.settings), rev);
	}

	async removeRev(id: string, rev: string): Promise<void> {
		await this.local.remove(await toStoredId(id, this.settings), rev);
	}

	// --- chunk storage -----------------------------------------------------

	/**
	 * Store a chunk only if it does not already exist (chunks are immutable). The
	 * bytes are written as a binary attachment, so CouchDB stores them binary and the
	 * document body stays tiny.
	 */
	async putChunkIfAbsent(id: string, enc: boolean, bytes: Uint8Array): Promise<void> {
		const db = this.local as unknown as PouchDB.Database;
		try {
			await db.get(id);
			return; // already present
		} catch (e) {
			if ((e as { status?: number }).status !== 404) throw e;
		}
		try {
			await db.put({
				_id: id,
				type: "chunk",
				enc,
				_attachments: {
					[CHUNK_ATTACHMENT]: {
						content_type: "application/octet-stream",
						// PouchDB accepts a base64 STRING for an inline attachment; CouchDB
						// stores it binary. (Transient base64 only — never the resting form.)
						data: uint8ToBase64(bytes),
					},
				},
			});
		} catch (e) {
			if ((e as { status?: number }).status !== 409) throw e; // created concurrently
		}
	}

	private async readChunk(
		db: PouchDB.Database<FileDoc>,
		id: string
	): Promise<ChunkBytes | null> {
		let enc = false;
		try {
			const doc = (await db.get(id)) as unknown as { enc?: boolean };
			enc = !!doc.enc;
		} catch (e) {
			if ((e as { status?: number }).status === 404) return null;
			throw e;
		}
		const att = await (db as unknown as PouchDB.Database).getAttachment(id, CHUNK_ATTACHMENT);
		return { enc, bytes: await attachmentToBytes(att) };
	}

	/** Fetch a single chunk's bytes from the local DB (or null). Keeps memory bounded. */
	async getChunkLocal(id: string): Promise<ChunkBytes | null> {
		return this.readChunk(this.local, id);
	}

	/** Fetch a single chunk's bytes directly from the remote DB (or null). */
	async getChunkRemote(id: string): Promise<ChunkBytes | null> {
		if (!this.remote) return null;
		return this.readChunk(this.remote, id);
	}

	/** Permanently delete the local replica (used by "Reset local database"). */
	async destroyLocal(): Promise<void> {
		await this.local.destroy();
	}

	// --- per-device local state (not replicated) ---------------------------

	async getLocalDoc<T>(id: string): Promise<T | null> {
		try {
			return (await this.local.get(id)) as unknown as T;
		} catch (e) {
			if ((e as { status?: number }).status === 404) return null;
			throw e;
		}
	}

	/**
	 * Upsert a document by id (read-then-write to attach the current _rev). NOTE: the
	 * "Local" in the name means "written on the local replica", NOT "non-replicating".
	 * Whether it replicates depends on the id: ids starting with "_local/" (the sync
	 * state and origin fingerprint) stay per-device; any other id (e.g. the master
	 * info doc "couchdb-sync:masterinfo") is a normal doc and DOES replicate.
	 */
	async putLocalDoc(id: string, value: Record<string, unknown>): Promise<void> {
		const existing = (await this.getLocalDoc<{ _rev?: string }>(id)) ?? {};
		await (this.local as unknown as PouchDB.Database).put({
			...value,
			_id: id,
			_rev: existing._rev,
		});
	}

	async close(): Promise<void> {
		await this.local.close();
		if (this.remote) await this.remote.close();
	}
}
