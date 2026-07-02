import { requestUrl, RequestUrlParam } from "obsidian";
import PouchDB from "pouchdb-browser";
import {
	ChunkDoc,
	CouchDBSyncSettings,
	FileDoc,
	FILE_PREFIX,
	HISTORY_PREFIX,
	HISTORY_SEP,
	VersionDoc,
} from "./types";

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
		// free (no second pass).
		const res = await this.local.allDocs({
			include_docs: true,
			conflicts: true,
			startkey: FILE_PREFIX,
			endkey: FILE_PREFIX + "￿",
		});
		const out: FileDoc[] = [];
		for (const row of res.rows) {
			const d = row.doc as FileDoc | undefined;
			if (d && d.type === "file") out.push(d);
		}
		return out;
	}

	async get(id: string): Promise<FileDoc | null> {
		try {
			return await this.local.get(id, { conflicts: true });
		} catch (e) {
			const err = e as { status?: number };
			if (err.status === 404) return null;
			throw e;
		}
	}

	async put(doc: FileDoc): Promise<void> {
		const existing = await this.get(doc._id);
		if (existing) doc._rev = existing._rev;
		await this.local.put(doc);
	}

	/** File documents that currently have unresolved conflict revisions. */
	async getConflicted(): Promise<FileDoc[]> {
		// File docs only (chunks are immutable and never conflict); range-bounded so
		// we never pull chunk data into memory.
		const res = await this.local.allDocs({
			include_docs: true,
			conflicts: true,
			startkey: FILE_PREFIX,
			endkey: FILE_PREFIX + "￿",
		});
		const out: FileDoc[] = [];
		for (const row of res.rows) {
			const d = row.doc as FileDoc | undefined;
			if (d && d.type === "file" && Array.isArray(d._conflicts) && d._conflicts.length > 0) {
				out.push(d);
			}
		}
		return out;
	}

	async getRev(id: string, rev: string): Promise<FileDoc> {
		return this.local.get(id, { rev });
	}

	// --- explicit per-file version history ---------------------------------

	/** All history entries for a path, oldest → newest (chronological). */
	async listVersions(path: string): Promise<VersionDoc[]> {
		const base = HISTORY_PREFIX + path + HISTORY_SEP;
		const res = await this.local.allDocs({
			include_docs: true,
			startkey: base,
			endkey: base + "￿",
		});
		const out: VersionDoc[] = [];
		for (const row of res.rows) {
			const d = row.doc as unknown as VersionDoc | undefined;
			if (d && d.type === "version") out.push(d);
		}
		return out;
	}

	/** Append a version entry (idempotent: ignores a same-id duplicate). */
	async putVersionIfAbsent(doc: VersionDoc): Promise<void> {
		const db = this.local as unknown as PouchDB.Database<VersionDoc>;
		try {
			await db.get(doc._id);
			return; // already recorded
		} catch (e) {
			if ((e as { status?: number }).status !== 404) throw e;
		}
		try {
			await db.put(doc);
		} catch (e) {
			if ((e as { status?: number }).status !== 409) throw e; // raced
		}
	}

	async removeVersion(id: string, rev: string): Promise<void> {
		await this.local.remove(id, rev);
	}

	async removeRev(id: string, rev: string): Promise<void> {
		await this.local.remove(id, rev);
	}

	// --- chunk storage -----------------------------------------------------

	/** Store a chunk only if it does not already exist (chunks are immutable). */
	async putChunkIfAbsent(doc: ChunkDoc): Promise<void> {
		const db = this.local as unknown as PouchDB.Database<ChunkDoc>;
		try {
			await db.get(doc._id);
			return; // already present
		} catch (e) {
			if ((e as { status?: number }).status !== 404) throw e;
		}
		try {
			await db.put(doc);
		} catch (e) {
			if ((e as { status?: number }).status !== 409) throw e; // created concurrently
		}
	}

	/** Fetch a single chunk from the local DB (or null). Keeps memory bounded. */
	async getChunkLocal(id: string): Promise<ChunkDoc | null> {
		try {
			return (await this.local.get(id)) as unknown as ChunkDoc;
		} catch (e) {
			if ((e as { status?: number }).status === 404) return null;
			throw e;
		}
	}

	/** Fetch a single chunk directly from the remote DB (or null). */
	async getChunkRemote(id: string): Promise<ChunkDoc | null> {
		if (!this.remote) return null;
		try {
			return (await this.remote.get(id)) as unknown as ChunkDoc;
		} catch (e) {
			if ((e as { status?: number }).status === 404) return null;
			throw e;
		}
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
