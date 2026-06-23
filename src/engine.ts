import {
	App,
	EventRef,
	FileSystemAdapter,
	Platform,
	TFile,
	TFolder,
	normalizePath,
	debounce,
} from "obsidian";
import { SyncDatabase } from "./database";
import { decryptString, encryptString } from "./crypto";
import {
	ChunkDoc,
	CHUNK_SIZE,
	CouchDBSyncSettings,
	FileDoc,
	FILE_PREFIX,
	SYNC_STATE,
	SyncRecord,
	SyncState,
} from "./types";
import {
	base64ToUint8,
	bytesToText,
	concatBytes,
	cyrb53,
	isHidden,
	looksLikeText,
	matchesIgnore,
	sha256Hex,
	splitBytes,
	textToBytes,
	uint8ToBase64,
} from "./util";

const MASTER_INFO_ID = "couchdb-sync:masterinfo";
const SYNC_STATE_DOC = "_local/couchdb-sync-state";
/** Suffix of the temp file used while streaming a download to disk. Never synced. */
const TMP_SUFFIX = ".cdbsync-tmp";

type StatusFn = (
	state: SyncState,
	detail?: string,
	progress?: { done: number; total: number }
) => void;

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
	private onReady: () => void;

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
	/** set when this session is being torn down; long loops bail out on it */
	private aborted = false;
	/** interval id for hidden-file polling (hidden files have no vault events) */
	private hiddenTimer: number | null = null;

	private resolveSoon = debounce(() => void this.resolveConflicts(), 800, false);
	private saveStateSoon = debounce(() => void this.persistSyncState(), 1500, false);

	constructor(
		app: App,
		db: SyncDatabase,
		settings: CouchDBSyncSettings,
		setStatus: StatusFn,
		onReady: () => void = () => undefined
	) {
		this.app = app;
		this.db = db;
		this.settings = settings;
		this.setStatus = setStatus;
		this.onReady = onReady;
	}

	// --- lifecycle ---------------------------------------------------------

	async start(): Promise<void> {
		this.setStatus(SYNC_STATE.CONNECTING);
		this.db.connectRemote();

		await this.loadSyncState();
		if (this.aborted) return;
		await this.publishMasterInfoIfNeeded();
		this.attachVaultEvents();

		// hidden files have no vault events -> poll for changes periodically
		if (this.settings.syncHidden) {
			this.hiddenTimer = window.setInterval(() => void this.scanHidden(), 30_000);
		}

		if (this.settings.liveSync) {
			// Start transfer immediately so already-indexed docs (and remote changes)
			// flow right away, then index local files in the background, small first.
			this.startLiveSync();
			void this.runInitialIndex();
		} else {
			await this.runInitialIndex();
			await this.replicateOnce();
		}
	}

	private async runInitialIndex(): Promise<void> {
		try {
			await this.cleanupTempDocs();
			await this.indexLocalFiles();
			if (this.settings.syncHidden) await this.scanHidden();
			await this.retryPending();
			await this.resolveConflicts();
			if (!this.aborted) this.onReady(); // reached a safe steady state -> clear crash guard
		} catch (e) {
			if (!this.aborted) this.fail("initial index", e);
		}
	}

	// --- hidden files (no vault events -> scanned by polling) ---------------

	/** Recursively list hidden files (dotfiles and files under dot-folders). */
	private async listHiddenFiles(): Promise<string[]> {
		const adapter = this.app.vault.adapter;
		const out: string[] = [];
		const walk = async (dir: string, insideHidden: boolean): Promise<void> => {
			if (this.aborted) return;
			let listing: { files: string[]; folders: string[] };
			try {
				listing = await adapter.list(dir);
			} catch {
				return;
			}
			for (const f of listing.files) {
				const base = f.split("/").pop() ?? "";
				if (insideHidden || base.startsWith(".")) out.push(f);
			}
			for (const sub of listing.folders) {
				const base = sub.split("/").pop() ?? "";
				if (insideHidden || base.startsWith(".")) await walk(sub, true);
			}
		};
		await walk("/", false);
		return out;
	}

	/** Index changed hidden files and propagate hidden deletions. Cheap stat checks. */
	private async scanHidden(): Promise<void> {
		if (!this.settings.syncHidden || this.aborted) return;
		const adapter = this.app.vault.adapter;
		const paths = (await this.listHiddenFiles()).filter((p) => !this.skip(p));
		const present = new Set(paths);

		for (const path of paths) {
			if (this.aborted) return;
			if (this.suppress.has(path)) {
				this.suppress.delete(path);
				continue;
			}
			const st = await adapter.stat(path);
			if (!st || st.type !== "file") continue;
			const rec = this.syncState.get(path);
			if (rec && rec.mtime === st.mtime && rec.size === st.size) continue; // unchanged
			try {
				await this.pushPath(path, st.mtime, st.ctime, st.size);
			} catch (e) {
				this.fail(`indexing ${path}`, e);
			}
			await this.yieldToUi();
		}

		// hidden files we synced before but are now gone -> tombstone
		for (const path of [...this.syncState.keys()]) {
			if (!isHidden(path) || this.skip(path) || present.has(path)) continue;
			if (!(await adapter.exists(path))) await this.handleLocalDelete(path);
		}
	}

	/**
	 * Remove stray streaming temp files ("*.cdbsync-tmp") that an earlier build
	 * accidentally indexed into the database. They never belong in the DB.
	 */
	private async cleanupTempDocs(): Promise<void> {
		try {
			const junk = (await this.db.getAll()).filter(
				(d) => d.path.endsWith(TMP_SUFFIX) && !d.deleted
			);
			for (const doc of junk) {
				if (doc._rev) await this.db.removeRev(doc._id, doc._rev); // tombstone, replicates
			}
			if (junk.length) {
				console.warn(`[couchdb-sync] removed ${junk.length} stray temp doc(s) from the database`);
			}
		} catch {
			/* best-effort */
		}
	}

	/** Signal a running session (e.g. a long initial scan) to stop as soon as possible. */
	abort(): void {
		this.aborted = true;
		if (this.hiddenTimer !== null) {
			window.clearInterval(this.hiddenTimer);
			this.hiddenTimer = null;
		}
		if (this.syncHandler) {
			this.syncHandler.cancel();
			this.syncHandler = null;
		}
	}

	stop(): void {
		this.abort();
		this.resolveSoon.cancel();
		this.saveStateSoon.cancel();
		for (const ref of this.eventRefs) this.app.vault.offref(ref);
		this.eventRefs = [];
	}

	getEventRefs(): EventRef[] {
		return this.eventRefs;
	}

	// --- live replication --------------------------------------------------

	private startLiveSync(): void {
		if (!this.db.remote) return;
		this.setStatus(SYNC_STATE.SYNCING);
		this.syncHandler = this.db.local
			// keep in-flight memory bounded: chunk docs can be ~1.4 MB each, so a large
			// default batch would buffer hundreds of MB and trip the OOM guard.
			.sync(this.db.remote, { live: true, retry: true, batch_size: 25, batches_limit: 2 })
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
		const opts = { batch_size: 25, batches_limit: 2 };
		try {
			await this.db.local.replicate.to(this.db.remote!, opts);
			const pull = await this.db.local.replicate.from(this.db.remote!, opts);
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

	// --- initial indexing (local -> local DB) ------------------------------

	/**
	 * Index local files into the database, SMALL FILES FIRST. This runs in the
	 * background while replication ships already-indexed docs in parallel, so the
	 * bulk of the vault syncs fast and huge media files trickle in last. It yields
	 * to the UI between files (mobile stays responsive) and is fully resumable:
	 * finished files are skipped via the sync record, and a half-uploaded big file
	 * only re-writes its missing chunks on the next run.
	 *
	 * Files only present in the database (not on this device) are NOT handled here —
	 * the pull side of replication delivers and applies those.
	 */
	private async indexLocalFiles(): Promise<void> {
		const todo = this.app.vault
			.getFiles()
			.filter((f) => !this.skip(f.path))
			.filter((f) => !this.isUnchanged(f))
			.sort((a, b) => a.stat.size - b.stat.size); // fewest chunks first

		if (todo.length === 0) return;
		let done = 0;
		for (const file of todo) {
			if (this.aborted) return;
			try {
				await this.pushFile(file); // adopts identical content without re-uploading
			} catch (e) {
				this.fail(`indexing ${file.path}`, e); // one bad file must not abort the rest
			}
			done++;
			this.setStatus(SYNC_STATE.SYNCING, `Indexing ${done}/${todo.length}…`, {
				done,
				total: todo.length,
			});
			await this.yieldToUi(); // keep the app responsive; let replication interleave
		}
	}

	/** Hand control back to the event loop so the UI/replication can make progress. */
	private yieldToUi(): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, 0));
	}

	/** Cheap "did this file change since we last synced it here?" check. */
	private isUnchanged(file: TFile): boolean {
		const rec = this.syncState.get(file.path);
		return !!rec && rec.mtime === file.stat.mtime && rec.size === file.stat.size;
	}

	/** Paths we never sync. */
	private skip(path: string): boolean {
		if (path.endsWith(TMP_SUFFIX)) return true;
		// never sync our own plugin config (deviceId/passphrase/flags are per-device)
		if (path === `${this.app.vault.configDir}/plugins/couchdb-sync/data.json`) return true;
		if (isHidden(path)) {
			// hidden files only when enabled, minus the hidden exclusion list
			return !this.settings.syncHidden || matchesIgnore(path, this.settings.hiddenExcludePatterns);
		}
		return matchesIgnore(path, this.settings.ignorePatterns);
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
		if (this.skip(file.path)) return;
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
		if (this.skip(path)) return;
		if (this.suppress.has(path)) {
			this.suppress.delete(path);
			return;
		}
		const doc = await this.db.get(FILE_PREFIX + path);
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
		await this.pushPath(file.path, file.stat.mtime, file.stat.ctime, file.stat.size);
	}

	/** Index a file (normal or hidden) into the database by its vault-relative path. */
	private async pushPath(path: string, mtime: number, ctime: number, size: number): Promise<void> {
		if (this.settings.e2eeEnabled && !this.settings.passphrase) {
			this.setStatus(SYNC_STATE.ERROR, "Encryption is on but no passphrase is set.");
			return;
		}
		const enc = this.settings.e2eeEnabled;
		const pass = this.settings.passphrase;

		// Stream the file in pieces so even multi-hundred-MB files never sit in memory
		// or get turned into one giant string. Each piece becomes one immutable chunk.
		// The first piece also decides, by content, whether this is a text or binary file.
		const children: string[] = [];
		let binary = false;
		let firstPiece = true;
		for await (const piece of this.streamChunksPath(path)) {
			if (this.aborted) return;
			if (firstPiece) {
				binary = !looksLikeText(piece);
				firstPiece = false;
			}
			const b64 = uint8ToBase64(piece);
			const id = "h:" + (await sha256Hex(textToBytes((enc ? pass : "") + ":" + b64)));
			children.push(id);
			await this.db.putChunkIfAbsent({
				_id: id,
				type: "chunk",
				enc,
				data: enc ? await encryptString(b64, pass) : b64,
			});
			// for very large files, yield periodically so the UI/replication keep moving
			if (children.length % 16 === 0) await this.yieldToUi();
		}
		const hash = cyrb53(children.join("|"));

		const existing = await this.db.get(FILE_PREFIX + path);
		if (existing && !existing.deleted && existing.hash === hash) {
			// identical content already in the DB — adopt it, no upload, no conflict
			this.lastHash.set(path, hash);
			this.recordSynced(path, mtime, size, hash);
			return;
		}

		const doc: FileDoc = {
			_id: FILE_PREFIX + path,
			_rev: existing?._rev,
			type: "file",
			path,
			mtime,
			ctime,
			size,
			deleted: false,
			deviceId: this.settings.deviceId,
			binary,
			enc,
			children,
			hash,
		};
		await this.db.put(doc);
		this.lastHash.set(path, hash);
		this.recordSynced(path, mtime, size, hash);
	}

	/**
	 * Yield a file's content in CHUNK_SIZE byte pieces. On desktop, content is read
	 * incrementally from disk (constant memory, any size). Otherwise the whole file is
	 * read via the adapter (works for hidden files too). Never decoded as a string.
	 */
	private async *streamChunksPath(path: string): AsyncGenerator<Uint8Array> {
		const adapter = this.app.vault.adapter;
		if (Platform.isDesktop && adapter instanceof FileSystemAdapter) {
			const fullPath = adapter.getFullPath(path);
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const fs = require("fs") as typeof import("fs");
			const fd = await fs.promises.open(fullPath, "r");
			try {
				const buf = new Uint8Array(CHUNK_SIZE);
				for (;;) {
					if (this.aborted) return;
					const { bytesRead } = await fd.read(buf, 0, CHUNK_SIZE, null);
					if (bytesRead === 0) break;
					yield buf.slice(0, bytesRead); // copy out before the buffer is reused
				}
			} finally {
				await fd.close();
			}
			return;
		}

		// Mobile / non-FS adapter: read the whole file as raw bytes (works for hidden).
		const bytes = new Uint8Array(await adapter.readBinary(path));
		for (const piece of splitBytes(bytes, CHUNK_SIZE)) yield piece;
	}

	// --- db -> local -------------------------------------------------------

	private async applyRemoteChange(doc: FileDoc): Promise<void> {
		const path = doc.path || doc._id;
		if (this.skip(path)) return;

		const hidden = isHidden(path);
		const adapter = this.app.vault.adapter;
		const existing = hidden ? null : this.app.vault.getAbstractFileByPath(path);

		if (doc.deleted) {
			this.suppress.add(path);
			if (hidden) {
				if (await adapter.exists(path)) await adapter.remove(path);
			} else if (existing instanceof TFile) {
				await this.app.fileManager.trashFile(existing);
			}
			this.lastHash.delete(path);
			this.syncState.delete(path);
			this.saveStateSoon();
			return;
		}

		// nothing to do if we already hold this exact version
		if (this.lastHash.get(path) === doc.hash) return;

		const children = Array.isArray(doc.children) ? doc.children : null;
		if (!children) {
			console.warn(`[couchdb-sync] skipping ${path}: no chunk list (legacy/incompatible doc)`);
			return;
		}

		const desktopFs = Platform.isDesktop && adapter instanceof FileSystemAdapter;
		try {
			if (doc.binary && desktopFs) {
				// Stream chunks straight to disk: never hold the whole file in memory.
				await this.writeBinaryStreaming(path, children, adapter as FileSystemAdapter, doc.hash);
			} else {
				await this.writeAssembled(path, children, doc.binary, hidden, existing, doc.hash);
			}
		} catch (e) {
			// chunks not here yet -> wait for them to replicate, then retry
			this.pending.set(doc._id, doc);
			console.warn(`[couchdb-sync] deferring ${path}: ${(e as Error).message}`);
			return;
		}
		this.pending.delete(doc._id);
	}

	/** Read one chunk's decrypted bytes (local, falling back to remote). */
	private async readChunkBytes(id: string): Promise<Uint8Array> {
		let chunk = await this.db.getChunkLocal(id);
		if (!chunk) {
			chunk = await this.db.getChunkRemote(id);
			if (chunk) await this.db.putChunkIfAbsent(chunk); // cache locally
		}
		if (!chunk) throw new Error(`missing chunk ${id}`);
		const b64 = chunk.enc
			? await decryptString(chunk.data, this.settings.passphrase)
			: chunk.data;
		return base64ToUint8(b64);
	}

	/** Desktop: write a binary file chunk-by-chunk to a temp file, then rename in. */
	private async writeBinaryStreaming(
		path: string,
		children: string[],
		adapter: FileSystemAdapter,
		hash: string
	): Promise<void> {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const fs = require("fs") as typeof import("fs");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const nodePath = require("path") as typeof import("path");
		const full = adapter.getFullPath(path);
		await fs.promises.mkdir(nodePath.dirname(full), { recursive: true });
		const tmp = full + TMP_SUFFIX;
		const fd = await fs.promises.open(tmp, "w");
		try {
			for (const id of children) {
				await fd.write(await this.readChunkBytes(id));
			}
		} catch (e) {
			await fd.close();
			await fs.promises.unlink(tmp).catch(() => undefined);
			throw e; // partial temp file removed; nothing corrupted
		}
		await fd.close();
		this.suppress.add(path);
		this.lastHash.set(path, hash);
		await fs.promises.rename(tmp, full); // atomic swap into place
		const st = await fs.promises.stat(full);
		this.recordSynced(path, st.mtimeMs, st.size, hash);
	}

	/** In-memory assembly for text files (small) and the mobile fallback. */
	private async writeAssembled(
		path: string,
		children: string[],
		binary: boolean,
		hidden: boolean,
		existing: ReturnType<App["vault"]["getAbstractFileByPath"]>,
		hash: string
	): Promise<void> {
		const parts: Uint8Array[] = [];
		for (const id of children) parts.push(await this.readChunkBytes(id));
		const bytes = concatBytes(parts);

		this.suppress.add(path);
		this.lastHash.set(path, hash);
		await this.ensureFolder(path, hidden);
		const adapter = this.app.vault.adapter;

		if (binary) {
			const buf = new ArrayBuffer(bytes.byteLength);
			new Uint8Array(buf).set(bytes);
			if (hidden) await adapter.writeBinary(path, buf);
			else if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, buf);
			else await this.app.vault.createBinary(path, buf);
		} else {
			const text = bytesToText(bytes);
			if (hidden) await adapter.write(path, text);
			else if (existing instanceof TFile) await this.app.vault.modify(existing, text);
			else await this.app.vault.create(path, text);
		}

		if (hidden) {
			const st = await adapter.stat(path);
			if (st) this.recordSynced(path, st.mtime, st.size, hash);
		} else {
			const written = this.app.vault.getAbstractFileByPath(path);
			if (written instanceof TFile) {
				this.recordSynced(path, written.stat.mtime, written.stat.size, hash);
			}
		}
	}

	private async ensureFolder(filePath: string, hidden: boolean): Promise<void> {
		const dir = normalizePath(filePath.split("/").slice(0, -1).join("/"));
		if (!dir || dir === "/" || dir === ".") return;
		const adapter = this.app.vault.adapter;
		if (hidden) {
			// build nested dot-folders via the adapter (vault.createFolder skips dotfolders)
			const parts = dir.split("/");
			let cur = "";
			for (const p of parts) {
				cur = cur ? `${cur}/${p}` : p;
				if (!(await adapter.exists(cur))) {
					try {
						await adapter.mkdir(cur);
					} catch {
						/* exists / race */
					}
				}
			}
			return;
		}
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
			this.lastHash.delete(doc.path);
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
			.filter((f) => !this.skip(f.path));
		const vaultByPath = new Map(vaultFiles.map((f) => [f.path, f] as const));

		const docs = (await this.db.getAll()).filter((d) => !d.deleted);
		const docByPath = new Map(docs.map((d) => [d.path, d] as const));

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
			if (!vaultByPath.has(d.path)) dbOnly.push(d.path);
		}

		const sort = (a: string[]) => a.sort((x, y) => x.localeCompare(y));
		return {
			vaultCount: vaultFiles.length,
			dbCount: docs.length,
			inSync: sort(inSync),
			localOnly: sort(localOnly),
			dbOnly: sort(dbOnly),
			drift: sort(drift),
			allDbPaths: sort(docs.map((d) => d.path)),
		};
	}
}
