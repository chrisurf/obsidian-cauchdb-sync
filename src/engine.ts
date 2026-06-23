import { App, EventRef, TFile, TFolder, normalizePath, debounce } from "obsidian";
import { SyncDatabase } from "./database";
import { decryptString, encryptString } from "./crypto";
import {
	ChunkDoc,
	CHUNK_SIZE,
	CouchDBSyncSettings,
	FileDoc,
	SYNC_STATE,
	SyncRecord,
	SyncState,
} from "./types";
import {
	base64ToUint8,
	bytesToText,
	concatBytes,
	cyrb53,
	isBinaryPath,
	matchesIgnore,
	sha256Hex,
	splitBytes,
	textToBytes,
	uint8ToBase64,
} from "./util";

const MASTER_INFO_ID = "couchdb-sync:masterinfo";
const SYNC_STATE_DOC = "_local/couchdb-sync-state";

type StatusFn = (state: SyncState, detail?: string) => void;

/** Snapshot comparing this device's files against the synced database. */
export interface IndexReport {
	vaultCount: number;
	dbCount: number;
	inSync: string[];
	localOnly: string[]; // on this device, not yet in the database
	dbOnly: string[]; // in the database, not on this device
	drift: string[]; // present on both but content differs
	allDbPaths: string[]; // every indexed path (for the tree view)
}

export class SyncEngine {
	private app: App;
	private db: SyncDatabase;
	private settings: CouchDBSyncSettings;
	private setStatus: StatusFn;

	private syncHandler: PouchDB.Replication.Sync<FileDoc> | null = null;
	private eventRefs: EventRef[] = [];

	/** path -> content fingerprint of the last value we synced (echo guard) */
	private lastHash = new Map<string, string>();
	/** paths we are about to write ourselves; their next vault event is ignored */
	private suppress = new Set<string>();
	/** per-device record of each file's last-synced mtime/size/hash */
	private syncState = new Map<string, SyncRecord>();
	/** file docs we could not apply yet because some chunks were missing */
	private pending = new Map<string, FileDoc>();

	private resolveSoon = debounce(() => void this.resolveConflicts(), 800, false);
	private saveStateSoon = debounce(() => void this.persistSyncState(), 1500, false);

	constructor(app: App, db: SyncDatabase, settings: CouchDBSyncSettings, setStatus: StatusFn) {
		this.app = app;
		this.db = db;
		this.settings = settings;
		this.setStatus = setStatus;
	}

	// --- lifecycle ---------------------------------------------------------

	async start(): Promise<void> {
		this.setStatus(SYNC_STATE.CONNECTING);
		this.db.connectRemote();

		await this.loadSyncState();
		await this.publishMasterInfoIfNeeded();
		await this.reconcile();
		this.attachVaultEvents();

		if (this.settings.liveSync) {
			this.startLiveSync();
		} else {
			await this.replicateOnce();
		}
	}

	stop(): void {
		for (const ref of this.eventRefs) this.app.vault.offref(ref);
		this.eventRefs = [];
		if (this.syncHandler) {
			this.syncHandler.cancel();
			this.syncHandler = null;
		}
	}

	getEventRefs(): EventRef[] {
		return this.eventRefs;
	}

	// --- live replication --------------------------------------------------

	private startLiveSync(): void {
		if (!this.db.remote) return;
		this.setStatus(SYNC_STATE.SYNCING);
		this.syncHandler = this.db.local
			.sync(this.db.remote, { live: true, retry: true })
			.on("change", (info) => {
				if (info.direction === "pull") {
					void this.applyPulledDocs(info.change.docs as FileDoc[]);
				}
			})
			.on("paused", (err) => {
				this.setStatus(err ? SYNC_STATE.OFFLINE : SYNC_STATE.SYNCED);
			})
			.on("active", () => this.setStatus(SYNC_STATE.SYNCING))
			.on("denied", (err) => this.fail("replication denied", err))
			.on("error", (err) => this.fail("replication error", err));
	}

	/** Log the real error (with stack) and surface a short message to the UI. */
	private fail(context: string, e: unknown): void {
		console.error(`[couchdb-sync] ${context}:`, e);
		const msg = e instanceof Error ? e.message : String(e);
		this.setStatus(SYNC_STATE.ERROR, `${context}: ${msg}`);
	}

	async replicateOnce(): Promise<void> {
		if (!this.db.remote) this.db.connectRemote();
		this.setStatus(SYNC_STATE.SYNCING);
		try {
			await this.db.local.replicate.to(this.db.remote!);
			const pull = await this.db.local.replicate.from(this.db.remote!);
			await this.applyPulledDocs(pull.docs as FileDoc[]);
			await this.resolveConflicts();
			this.setStatus(SYNC_STATE.SYNCED);
		} catch (e) {
			this.fail("replicate", e);
		}
	}

	private async applyPulledDocs(docs: FileDoc[]): Promise<void> {
		for (const doc of docs) {
			if (!doc || doc.type !== "file") continue;
			await this.applyRemoteChange(doc);
		}
		await this.retryPending();
		this.resolveSoon();
	}

	/** Re-attempt file docs that were waiting for chunks to arrive. */
	private async retryPending(): Promise<void> {
		if (this.pending.size === 0) return;
		const todo = [...this.pending.values()];
		this.pending.clear();
		for (const doc of todo) {
			try {
				await this.applyRemoteChange(doc);
			} catch (e) {
				this.fail(`applying ${doc._id}`, e);
			}
		}
	}

	// --- initial reconcile -------------------------------------------------

	private async reconcile(): Promise<void> {
		const localFiles = this.app.vault
			.getFiles()
			.filter((f) => !matchesIgnore(f.path, this.settings.ignorePatterns));
		const localByPath = new Map(localFiles.map((f) => [f.path, f] as const));

		const docs = await this.db.getAll();
		const docByPath = new Map(docs.map((d) => [d._id, d] as const));

		// 1) files present locally -> ensure they are in the DB
		for (const file of localFiles) {
			try {
				if (this.isUnchanged(file)) continue; // matches our last-synced record
				const doc = docByPath.get(file.path);
				if (doc && !doc.deleted && (await this.hashLocal(file)) === doc.hash) {
					// identical content already in the DB — just adopt it, no upload/conflict
					this.recordSynced(file.path, file.stat.mtime, file.stat.size, doc.hash);
					this.lastHash.set(file.path, doc.hash);
				} else {
					await this.pushFile(file);
				}
			} catch (e) {
				this.fail(`indexing ${file.path}`, e); // one bad file must not abort startup
			}
		}

		// 2) docs present in DB but missing locally -> create or honor tombstone
		for (const doc of docs) {
			if (localByPath.has(doc._id)) continue;
			try {
				await this.applyRemoteChange(doc);
			} catch (e) {
				this.fail(`applying ${doc._id}`, e);
			}
		}

		await this.retryPending();
		await this.resolveConflicts();
	}

	/** Cheap "did this file change since we last synced it here?" check. */
	private isUnchanged(file: TFile): boolean {
		const rec = this.syncState.get(file.path);
		return !!rec && rec.mtime === file.stat.mtime && rec.size === file.stat.size;
	}

	// --- local -> db -------------------------------------------------------

	private attachVaultEvents(): void {
		const onModify = debounce(
			(file: TFile) => void this.handleLocalUpsert(file),
			400,
			false
		);
		this.eventRefs.push(
			this.app.vault.on("create", (f) => f instanceof TFile && onModify(f)),
			this.app.vault.on("modify", (f) => f instanceof TFile && onModify(f)),
			this.app.vault.on("delete", (f) => void this.handleLocalDelete(f.path)),
			this.app.vault.on("rename", (f, oldPath) => {
				void this.handleLocalDelete(oldPath);
				if (f instanceof TFile) void this.handleLocalUpsert(f);
			})
		);
	}

	private async handleLocalUpsert(file: TFile): Promise<void> {
		if (matchesIgnore(file.path, this.settings.ignorePatterns)) return;
		if (this.suppress.has(file.path)) {
			this.suppress.delete(file.path);
			return;
		}
		if (this.isUnchanged(file)) return;
		try {
			await this.pushFile(file);
		} catch (e) {
			this.fail(`pushing ${file.path}`, e);
		}
	}

	private async handleLocalDelete(path: string): Promise<void> {
		if (matchesIgnore(path, this.settings.ignorePatterns)) return;
		if (this.suppress.has(path)) {
			this.suppress.delete(path);
			return;
		}
		const doc = await this.db.get(path);
		if (!doc || doc.deleted) return;
		doc.deleted = true;
		doc._deleted = false; // keep a tombstone document (logical delete)
		doc.children = [];
		doc.hash = "";
		doc.size = 0;
		doc.mtime = Date.now();
		doc.deviceId = this.settings.deviceId;
		await this.db.put(doc);
		this.lastHash.delete(path);
		this.syncState.delete(path);
		this.saveStateSoon();
	}

	private async pushFile(file: TFile): Promise<void> {
		if (this.settings.e2eeEnabled && !this.settings.passphrase) {
			this.setStatus(SYNC_STATE.ERROR, "Encryption is on but no passphrase is set.");
			return;
		}

		const bytes = await this.readBytes(file);
		const { children, chunks } = await this.buildChunks(bytes);
		const hash = cyrb53(children.join("|"));
		if (this.lastHash.get(file.path) === hash) {
			this.recordSynced(file.path, file.stat.mtime, file.stat.size, hash);
			return; // content unchanged / our own echo
		}

		// store any not-yet-existing chunks first, so the file doc never dangles
		for (const chunk of chunks) await this.db.putChunkIfAbsent(chunk);

		const existing = await this.db.get(file.path);
		const doc: FileDoc = {
			_id: file.path,
			_rev: existing?._rev,
			type: "file",
			path: file.path,
			mtime: file.stat.mtime,
			ctime: file.stat.ctime,
			size: file.stat.size,
			deleted: false,
			deviceId: this.settings.deviceId,
			binary: isBinaryPath(file.path),
			enc: this.settings.e2eeEnabled,
			children,
			hash,
		};
		await this.db.put(doc);
		this.lastHash.set(file.path, hash);
		this.recordSynced(file.path, file.stat.mtime, file.stat.size, hash);
	}

	private async readBytes(file: TFile): Promise<Uint8Array> {
		if (isBinaryPath(file.path)) {
			return new Uint8Array(await this.app.vault.readBinary(file));
		}
		return textToBytes(await this.app.vault.read(file));
	}

	/** Split bytes into content-addressed, optionally encrypted chunk documents. */
	private async buildChunks(
		bytes: Uint8Array
	): Promise<{ children: string[]; chunks: ChunkDoc[] }> {
		const enc = this.settings.e2eeEnabled;
		const pass = this.settings.passphrase;
		const children: string[] = [];
		const chunks: ChunkDoc[] = [];
		for (const piece of splitBytes(bytes, CHUNK_SIZE)) {
			const b64 = uint8ToBase64(piece);
			const id = "h:" + (await sha256Hex(textToBytes((enc ? pass : "") + ":" + b64)));
			children.push(id);
			chunks.push({
				_id: id,
				type: "chunk",
				enc,
				data: enc ? await encryptString(b64, pass) : b64,
			});
		}
		return { children, chunks };
	}

	/** Content fingerprint of a local file (chunk ids only, no encryption work). */
	private async hashLocal(file: TFile): Promise<string> {
		const enc = this.settings.e2eeEnabled;
		const pass = this.settings.passphrase;
		const ids: string[] = [];
		for (const piece of splitBytes(await this.readBytes(file), CHUNK_SIZE)) {
			const b64 = uint8ToBase64(piece);
			ids.push("h:" + (await sha256Hex(textToBytes((enc ? pass : "") + ":" + b64))));
		}
		return cyrb53(ids.join("|"));
	}

	// --- db -> local -------------------------------------------------------

	private async applyRemoteChange(doc: FileDoc): Promise<void> {
		const path = doc.path || doc._id;
		if (matchesIgnore(path, this.settings.ignorePatterns)) return;

		const existing = this.app.vault.getAbstractFileByPath(path);

		if (doc.deleted) {
			if (existing instanceof TFile) {
				this.suppress.add(path);
				await this.app.fileManager.trashFile(existing);
			}
			this.lastHash.delete(path);
			this.syncState.delete(path);
			this.saveStateSoon();
			return;
		}

		// nothing to do if we already hold this exact version
		if (this.lastHash.get(path) === doc.hash) return;

		let bytes: Uint8Array;
		try {
			bytes = await this.reassemble(doc);
		} catch (e) {
			// chunks not here yet -> wait for them to replicate, then retry
			this.pending.set(doc._id, doc);
			console.warn(`[couchdb-sync] deferring ${path}: ${(e as Error).message}`);
			return;
		}

		this.lastHash.set(path, doc.hash);
		this.suppress.add(path);
		await this.ensureFolder(path);

		if (doc.binary) {
			const buf = new ArrayBuffer(bytes.byteLength);
			new Uint8Array(buf).set(bytes);
			if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, buf);
			else await this.app.vault.createBinary(path, buf);
		} else {
			const text = bytesToText(bytes);
			if (existing instanceof TFile) await this.app.vault.modify(existing, text);
			else await this.app.vault.create(path, text);
		}

		const written = this.app.vault.getAbstractFileByPath(path);
		if (written instanceof TFile) {
			this.recordSynced(path, written.stat.mtime, written.stat.size, doc.hash);
		}
		this.pending.delete(doc._id);
	}

	/** Rebuild file bytes from chunk docs; pulls missing chunks from remote. */
	private async reassemble(doc: FileDoc): Promise<Uint8Array> {
		if (doc.children.length === 0) return new Uint8Array(0);

		let map = await this.db.getChunksLocal(doc.children);
		const missing = doc.children.filter((id) => !map.has(id));
		if (missing.length > 0) {
			const remote = await this.db.getChunksRemote(missing);
			for (const [id, chunk] of remote) {
				await this.db.putChunkIfAbsent(chunk); // cache locally
				map.set(id, chunk);
			}
		}

		const parts: Uint8Array[] = [];
		for (const id of doc.children) {
			const chunk = map.get(id);
			if (!chunk) throw new Error(`missing chunk ${id}`);
			const b64 = chunk.enc ? await decryptString(chunk.data, this.settings.passphrase) : chunk.data;
			parts.push(base64ToUint8(b64));
		}
		return concatBytes(parts);
	}

	private async ensureFolder(filePath: string): Promise<void> {
		const dir = normalizePath(filePath.split("/").slice(0, -1).join("/"));
		if (!dir || dir === "/" || dir === ".") return;
		if (this.app.vault.getAbstractFileByPath(dir) instanceof TFolder) return;
		try {
			await this.app.vault.createFolder(dir);
		} catch {
			/* already exists / race — ignore */
		}
	}

	// --- conflict resolution ----------------------------------------------

	private async resolveConflicts(): Promise<void> {
		let conflicted: FileDoc[];
		try {
			conflicted = await this.db.getConflicted();
		} catch {
			return;
		}
		if (conflicted.length === 0) return;

		const masterId = await this.getMasterId();
		for (const doc of conflicted) {
			const revs = [doc._rev!, ...(doc._conflicts ?? [])];
			const cands = await Promise.all(revs.map((r) => this.db.getRev(doc._id, r)));

			let winner: FileDoc | undefined;
			if (this.settings.conflictStrategy === "master" && masterId) {
				winner = cands.find((c) => c.deviceId === masterId);
			}
			// fallback (and the "newest" strategy): largest mtime wins
			if (!winner) {
				winner = cands.slice().sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))[0];
			}

			// force the winner's body onto the current winning revision...
			await this.db.put({ ...winner, _id: doc._id, _rev: doc._rev });
			// ...then drop every losing leaf so the conflict is gone for good.
			for (const r of revs) {
				if (r !== doc._rev) await this.db.removeRev(doc._id, r);
			}
			this.lastHash.delete(doc._id);
			await this.applyRemoteChange({ ...winner, _rev: undefined });
		}
		this.setStatus(SYNC_STATE.SYNCED, `Resolved ${conflicted.length} conflict(s).`);
	}

	// --- master coordination ----------------------------------------------

	private async publishMasterInfoIfNeeded(): Promise<void> {
		if (!this.settings.isMaster) return;
		try {
			await this.db.putLocalDoc(MASTER_INFO_ID, {
				type: "masterinfo",
				masterId: this.settings.deviceId,
			});
		} catch {
			/* best-effort */
		}
	}

	private async getMasterId(): Promise<string | null> {
		try {
			const info = (await this.db.local.get(MASTER_INFO_ID)) as unknown as {
				masterId: string;
			};
			return info.masterId ?? null;
		} catch {
			return null;
		}
	}

	// --- per-device sync state --------------------------------------------

	private recordSynced(path: string, mtime: number, size: number, hash: string): void {
		this.syncState.set(path, { mtime, size, hash });
		this.saveStateSoon();
	}

	private async loadSyncState(): Promise<void> {
		const doc = await this.db
			.getLocalDoc<{ records?: Record<string, SyncRecord> }>(SYNC_STATE_DOC)
			.catch(() => null);
		this.syncState = new Map(Object.entries(doc?.records ?? {}));
	}

	private async persistSyncState(): Promise<void> {
		try {
			await this.db.putLocalDoc(SYNC_STATE_DOC, {
				records: Object.fromEntries(this.syncState),
			});
		} catch (e) {
			console.warn("[couchdb-sync] could not persist sync state", e);
		}
	}

	// --- index status (for the settings view) ------------------------------

	/**
	 * Compare this device's files against the synced database using the cheap
	 * per-device sync record (no re-hashing of large files needed).
	 */
	async getIndexReport(): Promise<IndexReport> {
		const vaultFiles = this.app.vault
			.getFiles()
			.filter((f) => !matchesIgnore(f.path, this.settings.ignorePatterns));
		const vaultByPath = new Map(vaultFiles.map((f) => [f.path, f] as const));

		const docs = (await this.db.getAll()).filter((d) => !d.deleted);
		const docByPath = new Map(docs.map((d) => [d._id, d] as const));

		const inSync: string[] = [];
		const localOnly: string[] = [];
		const dbOnly: string[] = [];
		const drift: string[] = [];

		for (const f of vaultFiles) {
			const doc = docByPath.get(f.path);
			if (!doc) {
				localOnly.push(f.path);
				continue;
			}
			const rec = this.syncState.get(f.path);
			const changedLocally = !rec || rec.mtime !== f.stat.mtime || rec.size !== f.stat.size;
			const dbDiffers = !rec || rec.hash !== doc.hash;
			(changedLocally || dbDiffers ? drift : inSync).push(f.path);
		}

		for (const d of docs) {
			if (!vaultByPath.has(d._id)) dbOnly.push(d._id);
		}

		const sort = (a: string[]) => a.sort((x, y) => x.localeCompare(y));
		return {
			vaultCount: vaultFiles.length,
			dbCount: docs.length,
			inSync: sort(inSync),
			localOnly: sort(localOnly),
			dbOnly: sort(dbOnly),
			drift: sort(drift),
			allDbPaths: sort(docs.map((d) => d._id)),
		};
	}
}
