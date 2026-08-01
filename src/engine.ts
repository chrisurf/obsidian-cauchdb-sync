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
import { nodeFs, nodePath } from "./node";
import { decryptBytes, decryptString, encryptBytes, encryptString } from "./crypto";
import { Wire, encActive, hydrateFile } from "./envelope";
import {
	CHUNK_SIZE,
	CouchDBSyncSettings,
	FileDoc,
	FILE_PREFIX,
	HISTORY_PREFIX,
	HISTORY_SEP,
	SYNC_STATE,
	SyncRecord,
	SyncState,
	VersionDoc,
} from "./types";
import {
	bytesToText,
	concatBytes,
	cyrb53,
	isHidden,
	isIdbClosingError,
	looksLikeText,
	matchesIgnore,
	pickConflictWinner,
	sha256Hex,
	shouldWalkHiddenDir,
	splitBytes,
	stringArraysEqual,
	textToBytes,
	toError,
} from "./util";

const MASTER_INFO_ID = "couchdb-sync:masterinfo";
/** Legacy single-doc per-device state (pre-sharding). Read once, then migrated away. */
const SYNC_STATE_DOC = "_local/couchdb-sync-state";
/** Sharded per-device state docs: "<prefix><bucket>". Each holds a slice of the map. */
const SYNC_STATE_PREFIX = "_local/couchdb-sync-state:";
/**
 * Number of shards the per-device sync state is split across. Each recordSynced only
 * rewrites its own (small) shard instead of the whole map, so a media-heavy initial
 * index no longer re-serializes thousands of records per flush. A fixed count keeps
 * the shard ids enumerable on load without needing to list _local docs.
 */
const SYNC_STATE_BUCKETS = 64;
/** Stop re-uploading to "heal" a file after this many consecutive attempts (anti-ping-pong). */
const HEAL_MAX_ATTEMPTS = 3;
/** Suffix of the temp file used while streaming a download to disk. Never synced. */
const TMP_SUFFIX = ".cdbsync-tmp";

/** Snapshot comparing this device's files against the synced database. */
export interface IndexReport {
	vaultCount: number;
	dbCount: number;
	inSync: string[];
	localOnly: string[]; // on this device, not yet in the database
	dbOnly: string[]; // in the database, not on this device
	drift: string[]; // present on both but content differs
	conflicts: string[]; // unresolved conflict revisions in the database
	excluded: string[]; // present locally or in the DB but filtered out by the skip rules
	allDbPaths: string[]; // every indexed path (for the tree view)
	/**
	 * Set when the database holds encrypted docs but NONE could be decrypted with
	 * the current passphrase — i.e. the passphrase is wrong. The UI must show a
	 * passphrase warning instead of classifying every file as "local only" (which
	 * would tempt the user to "Upload all" and mint divergent duplicates).
	 */
	passphraseError?: boolean;
}

/** True for paths we never sync. Shared by the engine and the index report. */
function isSkipped(path: string, app: App, settings: CouchDBSyncSettings): boolean {
	if (path.endsWith(TMP_SUFFIX)) return true;
	if (path === `${app.vault.configDir}/plugins/couchdb-sync/data.json`) return true;
	if (isHidden(path)) {
		return settings.syncHidden
			? matchesIgnore(path, settings.hiddenExclude) // ON: skip blacklisted
			: !matchesIgnore(path, settings.hiddenInclude); // OFF: skip unless whitelisted
	}
	return false; // normal files are always synced
}

/**
 * Recursively list hidden files (dotfiles and files under dot-folders) that are
 * actually in scope for syncing.
 *
 * The walk is PRUNED by the same skip rules the caller applies to the result
 * (see shouldWalkHiddenDir): an excluded folder is never entered at all. Without
 * that, a vault whose `.obsidian` holds plugin `node_modules` costs thousands of
 * serial `adapter.list()` calls on every index report — the dominant cost behind
 * an index view stuck on "Loading…". Files are still filtered by `isSkipped`
 * afterwards, so pruning only removes work, never changes the outcome.
 */
async function listHidden(
	app: App,
	settings: CouchDBSyncSettings,
	isAborted: () => boolean = () => false
): Promise<string[]> {
	const adapter = app.vault.adapter;
	const out: string[] = [];
	const walk = async (dir: string, insideHidden: boolean): Promise<void> => {
		if (isAborted()) return;
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
			if (!insideHidden && !base.startsWith(".")) continue; // not hidden — out of scope
			if (!shouldWalkHiddenDir(sub, settings)) continue; // whole subtree is skipped
			await walk(sub, true);
		}
	};
	await walk("/", false);
	return out;
}

/**
 * Read the full per-device sync state from disk: the legacy single doc (pre-sharding)
 * plus every shard. Shared by the engine's loader and the standalone index report so
 * the idle view classifies files exactly like a running session would.
 */
async function readSyncStateRecords(db: SyncDatabase): Promise<Map<string, SyncRecord>> {
	const map = new Map<string, SyncRecord>();
	const legacy = await db
		.getLocalDoc<{ records?: Record<string, SyncRecord> }>(SYNC_STATE_DOC)
		.catch(() => null);
	if (legacy?.records) for (const [p, r] of Object.entries(legacy.records)) map.set(p, r);
	for (let b = 0; b < SYNC_STATE_BUCKETS; b++) {
		const doc = await db
			.getLocalDoc<{ records?: Record<string, SyncRecord> }>(SYNC_STATE_PREFIX + b)
			.catch(() => null);
		if (doc?.records) for (const [p, r] of Object.entries(doc.records)) map.set(p, r);
	}
	return map;
}

/**
 * Build the index/drift report. Works WITHOUT a running session (reads the local
 * DB and the persisted sync record directly), and includes hidden files so the
 * settings view shows full transparency in every state.
 */
export async function buildIndexReport(
	app: App,
	settings: CouchDBSyncSettings,
	db: SyncDatabase,
	syncState?: Map<string, SyncRecord>
): Promise<IndexReport> {
	const records = syncState ?? (await readSyncStateRecords(db));

	const normal = app.vault.getFiles().map((f) => f.path);
	const hidden = settings.syncHidden ? await listHidden(app, settings) : [];
	const vaultPaths = [...normal, ...hidden].filter((p) => !isSkipped(p, app, settings));
	const vaultSet = new Set(vaultPaths);

	// One scan, with conflict info attached (allDocs conflicts:true). The database may
	// contain hidden docs pushed by another device; with hidden sync off (or a path
	// excluded) they must NOT appear as "pending" or in the tree — they are never
	// written — so we split the docs into allowed vs excluded by the same skip rules.
	const allDocs = (await db.getAll()).filter((d) => !d.deleted);
	// If the DB holds encrypted file docs but every one failed to decrypt, the
	// passphrase is wrong. Flag it so the UI warns instead of classifying the whole
	// vault as "local only" (which would tempt "Upload all" → divergent duplicates).
	const stats = db.getDecryptStats();
	const passphraseError = encActive(settings) && stats.seen > 0 && stats.failed === stats.seen;
	const docs = allDocs.filter((d) => !isSkipped(d.path, app, settings));
	const docByPath = new Map(docs.map((d) => [d.path, d] as const));

	const inSync: string[] = [];
	const localOnly: string[] = [];
	const dbOnly: string[] = [];
	const drift: string[] = [];
	const conflicts: string[] = [];

	for (const path of vaultPaths) {
		const doc = docByPath.get(path);
		if (!doc) {
			localOnly.push(path);
			continue;
		}
		const rec = records.get(path);
		(rec && rec.hash === doc.hash ? inSync : drift).push(path);
	}
	for (const d of docs) {
		if (!vaultSet.has(d.path)) dbOnly.push(d.path);
		// conflict info came free with the same scan (allDocs conflicts:true)
		if (Array.isArray(d._conflicts) && d._conflicts.length > 0) conflicts.push(d.path);
	}

	// Excluded files (bounded): only those that already exist as a normal
	// vault file or as a DB doc — never a full walk of .git/node_modules.
	const excluded: string[] = [];
	const seen = new Set<string>();
	for (const d of allDocs) {
		if (isSkipped(d.path, app, settings) && !seen.has(d.path)) {
			seen.add(d.path);
			excluded.push(d.path);
		}
	}
	for (const p of normal) {
		if (isSkipped(p, app, settings) && !seen.has(p)) {
			seen.add(p);
			excluded.push(p);
		}
	}

	const sort = (a: string[]) => a.sort((x, y) => x.localeCompare(y));
	return {
		vaultCount: vaultPaths.length,
		dbCount: docs.length,
		inSync: sort(inSync),
		localOnly: sort(localOnly),
		dbOnly: sort(dbOnly),
		drift: sort(drift),
		conflicts: sort(conflicts),
		excluded: sort(excluded),
		allDbPaths: sort(docs.map((d) => d.path)),
		passphraseError,
	};
}

/**
 * Remove file documents from the database by exact path (file) or path prefix
 * (folder). Tombstones replicate the removal; the local files on disk are left
 * untouched, so anything not excluded can be re-synced from local later.
 */
export async function removeFromDb(
	db: SyncDatabase,
	target: string,
	folder: boolean
): Promise<number> {
	const docs = await db.getAll();
	const prefix = target.endsWith("/") ? target : target + "/";
	const match = folder ? (p: string) => p === target || p.startsWith(prefix) : (p: string) => p === target;
	let n = 0;
	for (const d of docs) {
		if (!d.deleted && d._rev && match(d.path)) {
			await db.removeRev(d._id, d._rev);
			n++;
		}
	}
	return n;
}

type StatusFn = (state: SyncState, detail?: string) => void;

export class SyncEngine {
	private app: App;
	private db: SyncDatabase;
	private settings: CouchDBSyncSettings;
	private setStatus: StatusFn;
	private onReady: () => void;
	/** called when a DB operation fails because the local IndexedDB connection was closed */
	private onDbClosed: () => void;

	private syncHandler: PouchDB.Replication.Sync<FileDoc> | null = null;
	private eventRefs: EventRef[] = [];

	/** path -> content fingerprint of the last value we synced (echo guard) */
	private lastHash = new Map<string, string>();
	/** paths we are about to write ourselves; their next vault event is ignored */
	private suppress = new Set<string>();
	/** per-device record of each file's last-synced mtime/size/hash */
	private syncState = new Map<string, SyncRecord>();
	/** shards touched since the last persist — only these get rewritten */
	private dirtyStateBuckets = new Set<number>();
	/** file docs we could not apply yet because some chunks were missing */
	private pending = new Map<string, FileDoc>();
	/** per-path count of consecutive heal (re-upload) attempts, to stop ping-pong */
	private healAttempts = new Map<string, number>();
	/**
	 * Paths whose remote content cannot be materialized because a required chunk is
	 * missing on every reachable device and re-uploading did not converge. Kept OUT
	 * of `pending` so they are not retried on every pull (which would loop forever);
	 * cleared when a local edit or a manual resolve gives the path a fresh chance.
	 */
	private stuck = new Set<string>();
	/** set when this session is being torn down; long loops bail out on it */
	private aborted = false;
	/** interval id for hidden-file polling (hidden files have no vault events) */
	private hiddenTimer: number | null = null;
	/** timer that returns the status to "in sync" after replication activity settles */
	private settleTimer: number | null = null;
	/** per-file transfer progress: path -> {done, total} chunks (for live UI) */
	private activeProgress = new Map<string, { done: number; total: number }>();
	/** active one-shot replication, cancelled on abort to avoid "database is closed" */
	private oneShot: { cancel: () => void } | null = null;

	private resolveSoon = debounce(() => void this.resolveConflicts(), 800, false);
	private saveStateSoon = debounce(() => void this.persistSyncState(), 1500, false);

	constructor(
		app: App,
		db: SyncDatabase,
		settings: CouchDBSyncSettings,
		setStatus: StatusFn,
		onReady: () => void = () => undefined,
		onDbClosed: () => void = () => undefined
	) {
		this.app = app;
		this.db = db;
		this.settings = settings;
		this.setStatus = setStatus;
		this.onReady = onReady;
		this.onDbClosed = onDbClosed;
	}

	// --- lifecycle ---------------------------------------------------------

	async start(): Promise<void> {
		this.setStatus(SYNC_STATE.CONNECTING);
		this.db.connectRemote();

		await this.loadSyncState();
		if (this.aborted) return;
		await this.publishMasterInfoIfNeeded();

		// The heavy initial work always runs in the BACKGROUND so start() returns
		// immediately (otherwise the Reset/Restart button would appear to hang until
		// the whole vault is re-indexed and uploaded).
		if (this.settings.liveSync) {
			// continuous mode: watch the vault, poll hidden files, replicate live
			this.attachVaultEvents();
			if (this.settings.syncHidden) {
				this.hiddenTimer = window.setInterval(() => void this.scanHidden(), 30_000);
			}
			this.startLiveSync();
			void this.runInitialIndex();
		} else {
			// "sync on command" mode: one-shot pass, then go idle. No watching/polling.
			void (async () => {
				await this.runInitialIndex();
				if (!this.aborted) await this.replicateOnce();
			})();
		}
	}

	private async runInitialIndex(): Promise<void> {
		try {
			await this.cleanupTempFiles();
			await this.indexLocalFiles();
			if (this.settings.syncHidden) await this.scanHidden();
			await this.retryPending();
			// Download the files that live only in the database (the "remote only"
			// state) — the download half of a two-way Force sync.
			await this.materializeRemoteOnly();
			await this.resolveConflicts();
			if (!this.aborted) {
				this.onReady(); // reached a safe steady state -> clear crash guard
				// the indexing pass left the status on "Syncing…"; settle it now so the
				// spinner stops once the initial work is done (live events take over after).
				this.setStatus(SYNC_STATE.SYNCED);
			}
		} catch (e) {
			if (!this.aborted) this.fail("initial index", e);
		}
	}

	// --- hidden files (no vault events -> scanned by polling) ---------------

	/** Index changed hidden files and propagate hidden deletions. Cheap stat checks. */
	private async scanHidden(): Promise<void> {
		if (!this.settings.syncHidden || this.aborted) return;
		const adapter = this.app.vault.adapter;
		const paths = (await listHidden(this.app, this.settings, () => this.aborted)).filter(
			(p) => !this.skip(p)
		);
		const present = new Set(paths);

		for (const path of paths) {
			if (this.aborted) return;
			// Consume any echo token but still re-check below: a real change made in
			// the debounce window must not be swallowed just because we recently wrote.
			this.suppress.delete(path);
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

	/** Delete leftover "*.cdbsync-tmp" files on disk from interrupted downloads. */
	private async cleanupTempFiles(): Promise<void> {
		try {
			const adapter = this.app.vault.adapter;
			for (const f of this.app.vault.getFiles()) {
				if (f.path.endsWith(TMP_SUFFIX)) {
					await adapter.remove(f.path).catch(() => undefined);
				}
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
		if (this.settleTimer !== null) {
			window.clearTimeout(this.settleTimer);
			this.settleTimer = null;
		}
		if (this.oneShot) {
			try {
				this.oneShot.cancel();
			} catch {
				/* ignore */
			}
			this.oneShot = null;
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

	/** Files currently being transferred, with chunk progress (for the live UI). */
	getActiveTransfers(): { path: string; done: number; total: number }[] {
		return [...this.activeProgress].map(([path, p]) => ({ path, ...p }));
	}

	/** Remove a file/folder from the database index (local files are kept). */
	async removeFromIndex(target: string, folder: boolean): Promise<number> {
		const n = await removeFromDb(this.db, target, folder);
		const prefix = target.endsWith("/") ? target : target + "/";
		const hit = (p: string) => (folder ? p === target || p.startsWith(prefix) : p === target);
		for (const p of [...this.lastHash.keys()]) if (hit(p)) this.lastHash.delete(p);
		for (const [id, d] of [...this.pending]) if (hit(d.path)) this.pending.delete(id);
		return n;
	}

	// --- live replication --------------------------------------------------

	private startLiveSync(): void {
		if (!this.db.remote) return;
		this.syncHandler = this.db.local
			// keep in-flight memory bounded: chunk docs can be ~1.4 MB each, so a large
			// default batch would buffer hundreds of MB and trip the OOM guard.
			.sync(this.db.remote, { live: true, retry: true, batch_size: 25, batches_limit: 2 })
			.on("change", (info) => {
				if (info.direction === "pull") {
					void this.applyPulledDocs(info.change.docs);
				}
				this.markActivity(); // real data moved -> show spinner, then settle
			})
			// 'paused' = caught up / idle (or offline). This is the resting state, so the
			// spinner stops here. We deliberately ignore 'active' (it fires constantly on
			// the live longpoll cycle and would keep the spinner turning forever).
			.on("paused", (err) => this.settle(err ? SYNC_STATE.OFFLINE : SYNC_STATE.SYNCED))
			.on("denied", (err) => this.fail("replication denied", err))
			.on("error", (err) => this.fail("replication error", err));
	}

	/** Show the spinner for real replication activity, then auto-settle to "in sync". */
	private markActivity(): void {
		if (this.aborted) return;
		this.setStatus(SYNC_STATE.SYNCING);
		if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
		this.settleTimer = window.setTimeout(() => {
			this.settleTimer = null;
			if (!this.aborted) this.setStatus(SYNC_STATE.SYNCED);
		}, 2500);
	}

	/** Immediately move to a resting state and cancel any pending settle. */
	private settle(state: SyncState): void {
		if (this.settleTimer !== null) {
			window.clearTimeout(this.settleTimer);
			this.settleTimer = null;
		}
		if (!this.aborted) this.setStatus(state);
	}

	/** Log the real error (with stack) and surface a short message to the UI. */
	private fail(context: string, e: unknown): void {
		// During teardown (reset/restart) the DB is closing — those errors are expected
		// noise, not real failures, so keep them quiet.
		if (this.aborted) {
			console.debug(`[couchdb-sync] (aborted) ${context}:`, e);
			return;
		}
		// A closed local IndexedDB connection (mobile background/resume) is recoverable,
		// not a dead-end error: hand it to the recovery path (reopen the handle +
		// restart) and show a transient "reconnecting" state instead of a scary error.
		// The engine is bound to the now-dead handle, so it cannot heal itself in place.
		if (isIdbClosingError(e)) {
			console.debug(`[couchdb-sync] ${context}: local DB connection closed — recovering`, e);
			this.setStatus(SYNC_STATE.CONNECTING, "Reconnecting after the app was in the background…");
			this.onDbClosed();
			return;
		}
		console.error(`[couchdb-sync] ${context}:`, e);
		// toError, not String(e): PouchDB rejects with plain objects, which would
		// otherwise reach the status card as "[object Object]" instead of the reason.
		this.setStatus(SYNC_STATE.ERROR, `${context}: ${toError(e).message}`);
	}

	async replicateOnce(): Promise<void> {
		// Capture the connected handle: `this.db.remote` is nullable, and connectRemote
		// returns the very database it just assigned, so the local binding is both
		// null-safe and typed — no non-null assertion needed at the two call sites.
		const remote = this.db.remote ?? this.db.connectRemote();
		this.markActivity();
		const opts = { batch_size: 25, batches_limit: 2 };
		try {
			const repTo = this.db.local.replicate.to(remote, opts);
			this.oneShot = repTo;
			await repTo;
			// event-based pull: the resolved result has no `.docs`; the change events do.
			await new Promise<void>((resolve, reject) => {
				const rep = this.db.local.replicate.from(remote, opts);
				this.oneShot = rep;
				// PouchDB's replication handle is itself thenable and `.on()` returns it,
				// so the chain reads as a floating promise. The one we actually wait on is
				// this wrapper, settled by the events below.
				void rep
					.on("change", (info) => {
						void this.applyPulledDocs(info.docs ?? []);
					})
					.on("complete", () => resolve())
					.on("error", (e) => reject(toError(e)));
			});
			this.oneShot = null;
			await this.retryPending();
			await this.resolveConflicts();
			this.settle(SYNC_STATE.SYNCED);
		} catch (e) {
			this.fail("replicate", e);
		}
	}

	/** Connect and pull the server state once, without uploading. For followers. */
	async startDownloadOnly(): Promise<void> {
		this.setStatus(SYNC_STATE.CONNECTING);
		this.db.connectRemote();
		await this.loadSyncState();
		if (this.aborted) return;
		// background, then idle: pure download — no vault events, no upload, no live
		void (async () => {
			await this.cleanupTempFiles();
			await this.downloadOnce();
			if (!this.aborted) {
				this.onReady();
				this.settle(SYNC_STATE.SYNCED);
			}
		})();
	}

	private async downloadOnce(): Promise<void> {
		const remote = this.db.remote ?? this.db.connectRemote();
		this.markActivity();
		const opts = { batch_size: 25, batches_limit: 2 };
		try {
			await new Promise<void>((resolve, reject) => {
				const rep = this.db.local.replicate.from(remote, opts);
				this.oneShot = rep;
				// See replicateOnce: the handle is thenable, the wrapper is what we await.
				void rep
					.on("change", (info) => {
						void this.applyPulledDocs(info.docs ?? []);
					})
					.on("complete", () => resolve())
					.on("error", (e) => reject(toError(e)));
			});
			this.oneShot = null;
			await this.retryPending();
			// Replication only re-emits docs changed since the last checkpoint, so a
			// file already in the local replica but never written to disk would stay
			// "remote only". Materialize any such files now.
			await this.materializeRemoteOnly();
			await this.resolveConflicts();
		} catch (e) {
			this.fail("download", e);
		}
	}

	/**
	 * Download and write to disk every file that is in the database but NOT on this
	 * device — the "remote only" state. This is the DOWNLOAD half of a two-way sync:
	 * live replication pulls the file DOCS into the local replica, but a doc whose
	 * content was never materialized (a large file, or one pulled in an earlier
	 * session) then just sits as "remote only" until the user taps Download on each
	 * one. Running it as part of the initial pass makes Force sync actually fetch
	 * those files, as users expect. Missing chunks are fetched from the server by
	 * applyRemoteChange (or deferred to `pending` and retried), and files already on
	 * disk are skipped, so this only does work for the genuinely-missing ones.
	 */
	private async materializeRemoteOnly(): Promise<void> {
		const adapter = this.app.vault.adapter;
		let docs: FileDoc[];
		try {
			docs = (await this.db.getAll()).filter((d) => !d.deleted);
		} catch (e) {
			if (!this.aborted) this.fail("scanning for downloads", e);
			return;
		}
		for (const doc of docs) {
			if (this.aborted) return;
			const path = doc.path;
			if (this.skip(path)) continue;
			if (this.stuck.has(path)) continue; // known-unrecoverable — don't retry in a loop
			const onDisk = isHidden(path)
				? await adapter.exists(path)
				: this.app.vault.getAbstractFileByPath(path) instanceof TFile;
			if (onDisk) continue; // only the missing ones — "remote only"
			try {
				await this.applyRemoteChange(doc);
			} catch (e) {
				this.fail(`downloading ${path}`, e);
			}
			await this.yieldToUi();
		}
	}

	private async applyPulledDocs(docs: FileDoc[]): Promise<void> {
		if (!Array.isArray(docs)) return;
		for (const raw of docs) {
			if (!raw || raw.type !== "file") continue;
			let doc: FileDoc;
			try {
				// Pulled docs arrive RAW from the replication feed in wire form
				// (encrypted meta + hashed id); decrypt to engine form before applying.
				// A decrypt failure here almost always means a mismatched passphrase.
				doc = await hydrateFile(raw as unknown as Wire, this.settings);
			} catch (e) {
				this.fail(`decrypting pulled doc ${raw._id}`, e);
				continue;
			}
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
		for (const file of todo) {
			if (this.aborted) return;
			try {
				await this.pushFile(file); // adopts identical content without re-uploading
			} catch (e) {
				this.fail(`indexing ${file.path}`, e); // one bad file must not abort the rest
			}
			// Report progress the same way replication does — as "work is happening",
			// nothing more. Indexing and replication run interleaved, so two sources
			// writing different status texts used to overwrite each other several
			// times a second, which made the card's detail line flicker. Sharing one
			// activity signal removes the conflict at the root; the actual figures
			// come from the index report, which is the only counter in the UI.
			this.markActivity();
			await this.yieldToUi(); // keep the app responsive; let replication interleave
		}
	}

	/** Hand control back to the event loop so the UI/replication can make progress. */
	private yieldToUi(): Promise<void> {
		return new Promise((resolve) => window.setTimeout(resolve, 0));
	}

	/** Cheap "did this file change since we last synced it here?" check. */
	private isUnchanged(file: TFile): boolean {
		const rec = this.syncState.get(file.path);
		return !!rec && rec.mtime === file.stat.mtime && rec.size === file.stat.size;
	}

	/** Paths we never sync. Normal files are always synced; hidden files depend on the toggle. */
	private skip(path: string): boolean {
		return isSkipped(path, this.app, this.settings);
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
		this.stuck.delete(file.path); // a fresh local edit is a new chance to converge
		// Consume any echo token but do NOT return on it alone: if the user edited the
		// file inside the debounce window, its mtime/size differ from what we recorded,
		// so isUnchanged is false and we must still push their edit. Our own writes are
		// recognized as echoes by isUnchanged (recordSynced stored the written stat).
		this.suppress.delete(file.path);
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
		await this.recordVersion({
			path,
			mtime: doc.mtime,
			size: 0,
			hash: "",
			binary: false,
			enc: this.settings.e2eeEnabled,
			children: [],
			deleted: true,
		});
		this.lastHash.delete(path);
		this.forgetSynced(path);
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
		// estimate the chunk count up front so the UI can show a percentage immediately
		const total = Math.max(1, Math.ceil(size / CHUNK_SIZE));
		this.activeProgress.set(path, { done: 0, total });
		try {
			await this.pushPathInner(path, mtime, ctime, size, total);
		} finally {
			this.activeProgress.delete(path);
		}
	}

	private async pushPathInner(
		path: string,
		mtime: number,
		ctime: number,
		size: number,
		total: number
	): Promise<void> {
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
			// Content id over the RAW bytes, keyed with the passphrase when encrypting so
			// the id never leaks the plaintext to someone without the passphrase.
			const id = "h:" + (await sha256Hex(concatBytes([textToBytes((enc ? pass : "") + ":"), piece])));
			children.push(id);
			await this.db.putChunkIfAbsent(id, enc, enc ? await encryptBytes(piece, pass) : piece);
			this.activeProgress.set(path, { done: children.length, total: Math.max(total, children.length) });
			// for very large files, yield periodically so the UI/replication keep moving
			if (children.length % 16 === 0) await this.yieldToUi();
		}
		const hash = cyrb53(children.join("|"));

		const existing = await this.db.get(FILE_PREFIX + path);
		if (
			existing &&
			!existing.deleted &&
			stringArraysEqual(existing.children ?? [], children)
		) {
			// identical content already in the DB — adopt it, no upload, no conflict.
			// NB: compare the content-addressed chunk id LIST directly, not the cyrb53
			// `hash` — a hash collision would otherwise adopt genuinely different content
			// and silently drop this device's version. The hash stays a cheap fingerprint
			// for the drift UI only.
			// If this path carries conflict leaves (two devices wrote byte-identical
			// content, each making a rev), collapse them now so it stops showing red.
			this.lastHash.set(path, hash);
			this.recordSynced(path, mtime, size, hash);
			if (Array.isArray(existing._conflicts) && existing._conflicts.length > 0) {
				await this.dropLosingRevs(path);
			}
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
		await this.recordVersion({ path, mtime, size, hash, binary, enc, children, deleted: false });
	}

	/**
	 * Before a pulled change overwrites the on-disk file, make sure we are not
	 * silently destroying an un-synced local edit. Hashes the current on-disk
	 * content and, if it is neither what we last synced NOR the incoming version, it
	 * is an edit that never made it into the DB (e.g. made inside the onModify
	 * debounce window) — persist it (chunks + a history version) so the user can
	 * restore it. Returns "same-as-remote" when the disk already holds the incoming
	 * content (caller can skip the write), else "proceed".
	 *
	 * Bounded to reasonably-sized files: the race that loses data is hand-editing a
	 * note, and buffering huge media in memory to guard it is not worth it.
	 */
	private async preserveUnsyncedLocalEdit(
		path: string,
		existing: TFile,
		incomingHash: string
	): Promise<"same-as-remote" | "proceed"> {
		if (existing.stat.size > 8 * 1024 * 1024) return "proceed";
		const enc = this.settings.e2eeEnabled;
		const pass = this.settings.passphrase;
		const children: string[] = [];
		const pieces: Uint8Array[] = [];
		let binary = false;
		let firstPiece = true;
		try {
			for await (const piece of this.streamChunksPath(path)) {
				if (this.aborted) return "proceed";
				if (firstPiece) {
					binary = !looksLikeText(piece);
					firstPiece = false;
				}
				pieces.push(piece);
				children.push(
					"h:" + (await sha256Hex(concatBytes([textToBytes((enc ? pass : "") + ":"), piece])))
				);
			}
		} catch {
			return "proceed"; // unreadable — nothing to preserve
		}
		if (children.length === 0) return "proceed";
		const diskHash = cyrb53(children.join("|"));
		if (diskHash === incomingHash) return "same-as-remote"; // disk already == remote
		if (diskHash === this.lastHash.get(path)) return "proceed"; // disk == last synced: safe
		// Un-synced local edit → persist its content + a restorable history version.
		for (let i = 0; i < pieces.length; i++) {
			await this.db.putChunkIfAbsent(children[i], enc, enc ? await encryptBytes(pieces[i], pass) : pieces[i]);
		}
		await this.recordVersion({
			path,
			mtime: existing.stat.mtime,
			size: existing.stat.size,
			hash: diskHash,
			binary,
			enc,
			children,
			deleted: false,
			note: "local edit auto-saved before a remote update overwrote it",
		});
		console.warn(
			`[couchdb-sync] preserved an un-synced local edit of ${path} to history before applying the remote version`
		);
		return "proceed";
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
			const fs = nodeFs();
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
			this.forgetSynced(path);
			this.healAttempts.delete(path);
			return;
		}

		// nothing to do if we already hold this exact version
		if (this.lastHash.get(path) === doc.hash) {
			this.healAttempts.delete(path);
			return;
		}

		const children = Array.isArray(doc.children) ? doc.children : null;
		if (!children) {
			console.warn(`[couchdb-sync] skipping ${path}: malformed doc (no chunk list)`);
			return;
		}

		// Guard against silently clobbering an un-synced local edit (a change made
		// inside the onModify debounce window, or after a failed push). If the file
		// on disk differs from both what we last synced and the incoming version,
		// its content is preserved to history before we overwrite it.
		if (existing instanceof TFile) {
			if ((await this.preserveUnsyncedLocalEdit(path, existing, doc.hash)) === "same-as-remote") {
				this.lastHash.set(path, doc.hash);
				this.recordSynced(path, existing.stat.mtime, existing.stat.size, doc.hash);
				this.healAttempts.delete(path);
				return;
			}
		}

		const desktopFs = Platform.isDesktop && adapter instanceof FileSystemAdapter;
		this.activeProgress.set(path, { done: 0, total: children.length }); // UI: working on it
		try {
			if (doc.binary && desktopFs) {
				// Stream chunks straight to disk: never hold the whole file in memory.
				await this.writeBinaryStreaming(path, children, adapter, doc.hash);
			} else {
				await this.writeAssembled(path, children, doc.binary, hidden, existing, doc.hash);
			}
		} catch (e) {
			if (this.aborted) return; // teardown — ignore
			// A chunk is missing (e.g. a half-finished earlier upload). If we have the
			// file locally, HEAL by re-uploading it — this regenerates the missing
			// chunks — instead of waiting forever for a chunk that may never arrive.
			const haveLocal = hidden
				? await adapter.exists(path)
				: this.app.vault.getAbstractFileByPath(path) instanceof TFile;
			if (haveLocal) {
				const attempts = (this.healAttempts.get(path) ?? 0) + 1;
				if (attempts > HEAL_MAX_ATTEMPTS) {
					// Re-uploading is not converging — a required chunk is missing on
					// every reachable device. Do NOT re-park in `pending`: that would
					// re-attempt (and re-warn) on every pull forever. Mark the path
					// stuck, surface it once, and let a local edit / manual resolve /
					// a fresh remote revision give it another chance.
					this.activeProgress.delete(path);
					this.pending.delete(doc._id);
					this.healAttempts.delete(path);
					if (!this.stuck.has(path)) {
						this.stuck.add(path);
						console.error(
							`[couchdb-sync] cannot sync ${path}: a required chunk is missing on every reachable device`
						);
						this.setStatus(
							SYNC_STATE.ERROR,
							`Cannot sync "${path}" — a required chunk is missing on the server. Edit or resolve the file to retry.`
						);
					}
					return;
				}
				this.healAttempts.set(path, attempts);
				console.warn(
					`[couchdb-sync] healing ${path} (attempt ${attempts}) by re-uploading (was: ${(e as Error).message})`
				);
				this.activeProgress.delete(path);
				this.pending.delete(doc._id);
				this.lastHash.delete(path);
				await this.forceSync(path).catch((e2) => this.fail(`healing ${path}`, e2));
				return;
			}
			// no local copy -> wait for the chunk to replicate, then retry
			this.pending.set(doc._id, doc);
			console.warn(`[couchdb-sync] deferring ${path}: ${(e as Error).message}`);
			return;
		} finally {
			this.activeProgress.delete(path);
		}
		// applied cleanly -> clear pending + reset the heal backoff for this path
		this.pending.delete(doc._id);
		this.healAttempts.delete(path);
		this.stuck.delete(path);
	}

	/** Force (re)sync of a single path: re-upload if local exists, else re-download. */
	async forceSync(path: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		const hidden = isHidden(path);
		this.lastHash.delete(path);
		this.stuck.delete(path); // manual action gives this path a fresh chance
		const local = hidden ? null : this.app.vault.getAbstractFileByPath(path);
		if (hidden && (await adapter.exists(path))) {
			const st = await adapter.stat(path);
			if (st) await this.pushPath(path, st.mtime, st.ctime, st.size);
		} else if (local instanceof TFile) {
			await this.pushPath(path, local.stat.mtime, local.stat.ctime, local.stat.size);
		} else {
			const doc = await this.db.get(FILE_PREFIX + path);
			if (doc) await this.applyRemoteChange(doc);
		}
		await this.resolveConflicts();
	}

	// --- explicit file history -------------------------------------------------

	/** Append a version entry for a freshly-committed change and prune to the cap. */
	private async recordVersion(d: {
		path: string;
		mtime: number;
		size: number;
		hash: string;
		binary: boolean;
		enc: boolean;
		children: string[];
		deleted: boolean;
		note?: string;
	}): Promise<void> {
		const keep = Math.max(0, this.settings.keepHistory ?? 0);
		if (keep === 0) return;
		const ts = Date.now();
		const id =
			HISTORY_PREFIX +
			d.path +
			HISTORY_SEP +
			String(ts).padStart(15, "0") +
			HISTORY_SEP +
			(d.hash || "del").slice(0, 8);
		try {
			await this.db.putVersionIfAbsent({
				_id: id,
				type: "version",
				path: d.path,
				ts,
				mtime: d.mtime,
				size: d.size,
				hash: d.hash,
				deviceId: this.settings.deviceId,
				binary: d.binary,
				enc: d.enc,
				children: d.children,
				deleted: d.deleted,
				note: d.note,
			});
			await this.pruneHistory(d.path, keep);
		} catch (e) {
			console.warn(`[couchdb-sync] history record failed for ${d.path}:`, e);
		}
	}

	private async pruneHistory(path: string, keep: number): Promise<void> {
		const vers = await this.db.listVersions(path); // oldest -> newest
		for (let i = 0; i < vers.length - keep; i++) {
			const v = vers[i];
			if (v._rev) await this.db.removeVersion(v._id, v._rev).catch(() => undefined);
		}
	}

	/** Full history of a path, newest first. */
	async listHistory(path: string): Promise<VersionDoc[]> {
		const vers = await this.db.listVersions(path);
		return vers.sort((a, b) => b.ts - a.ts);
	}

	private async assembleChildren(children: string[]): Promise<Uint8Array> {
		const parts: Uint8Array[] = [];
		for (const id of children) parts.push(await this.readChunkBytes(id));
		return concatBytes(parts);
	}

	/** Decoded text of a version (null for binary or deletion entries). */
	async getVersionText(v: VersionDoc): Promise<string | null> {
		if (v.binary || v.deleted) return null;
		return bytesToText(await this.assembleChildren(v.children));
	}

	/** Current on-disk text of a path (null if missing or binary). */
	async getLocalText(path: string): Promise<string | null> {
		const adapter = this.app.vault.adapter;
		const hidden = isHidden(path);
		const exists = hidden
			? await adapter.exists(path)
			: this.app.vault.getAbstractFileByPath(path) instanceof TFile;
		if (!exists) return null;
		const bytes = new Uint8Array(await adapter.readBinary(path));
		if (!looksLikeText(bytes)) return null;
		return bytesToText(bytes);
	}

	/**
	 * Current decoded text of the DATABASE copy of a path (null when the DB has no
	 * copy, it is a tombstone, or it is binary). Assembled from the file doc's
	 * content-addressed chunks (local cache first, falling back to the remote), so
	 * the side-by-side merge editor can show what the server currently holds.
	 */
	async getRemoteText(path: string): Promise<string | null> {
		const doc = await this.db.get(FILE_PREFIX + path);
		if (!doc || doc.deleted || doc.binary) return null;
		return bytesToText(await this.assembleChildren(doc.children));
	}

	/** Restore an earlier version: make it the current content everywhere. */
	async restoreVersion(path: string, v: VersionDoc): Promise<void> {
		if (v.deleted) {
			await this.deleteEverywhere(path);
			return;
		}
		const existing = await this.db.get(FILE_PREFIX + path);
		const mtime = Date.now();
		const doc: FileDoc = {
			_id: FILE_PREFIX + path,
			_rev: existing?._rev,
			type: "file",
			path,
			mtime,
			ctime: existing?.ctime ?? mtime,
			size: v.size,
			deleted: false,
			deviceId: this.settings.deviceId,
			binary: v.binary,
			enc: v.enc,
			children: [...v.children],
			hash: v.hash,
		};
		this.lastHash.delete(path);
		await this.db.put(doc);
		await this.dropLosingRevs(path);
		await this.recordVersion({
			path,
			mtime,
			size: v.size,
			hash: v.hash,
			binary: v.binary,
			enc: v.enc,
			children: [...v.children],
			deleted: false,
			note: `restored from ${new Date(v.ts).toLocaleString()}`,
		});
		await this.applyRemoteChange({ ...doc, _rev: undefined });
	}

	// --- direct per-file actions ----------------------------------------------

	/** Drop all losing conflict leaves so the current head is the sole winner. */
	private async dropLosingRevs(path: string): Promise<void> {
		const id = FILE_PREFIX + path;
		const doc = await this.db.get(id);
		for (const r of doc?._conflicts ?? []) {
			await this.db.removeRev(id, r).catch(() => undefined);
		}
	}

	/** Overwrite this device's copy with the database version (force download). */
	async takeRemote(path: string): Promise<void> {
		const doc = await this.db.get(FILE_PREFIX + path);
		if (!doc || doc.deleted) throw new Error("not in the database");
		this.lastHash.delete(path);
		await this.applyRemoteChange({ ...doc, _rev: undefined });
		await this.dropLosingRevs(path);
	}

	/**
	 * Compare local and remote mtime and take whichever is newer.
	 * Falls back to takeRemote when the file only exists on one side.
	 */
	async useNewest(path: string): Promise<"local" | "remote"> {
		const adapter = this.app.vault.adapter;
		const hidden = isHidden(path);

		let localMtime: number | null = null;
		if (hidden) {
			if (await adapter.exists(path)) {
				const st = await adapter.stat(path);
				if (st) localMtime = st.mtime;
			}
		} else {
			const f = this.app.vault.getAbstractFileByPath(path);
			if (f instanceof TFile) localMtime = f.stat.mtime;
		}

		const doc = await this.db.get(FILE_PREFIX + path);
		const remoteMtime = doc && !doc.deleted ? doc.mtime : null;

		if (localMtime != null && remoteMtime != null) {
			if (localMtime >= remoteMtime) {
				await this.takeLocal(path);
				return "local";
			}
			await this.takeRemote(path);
			return "remote";
		}
		if (localMtime != null) {
			await this.takeLocal(path);
			return "local";
		}
		if (remoteMtime != null) {
			await this.takeRemote(path);
			return "remote";
		}
		throw new Error("file exists neither locally nor in the database");
	}

	/**
	 * Resolve a drifting or conflicting file by the configured conflict strategy —
	 * never by a blind local upload. "newest" takes the newer mtime (data-safe, so a
	 * newer remote version is not discarded); "master" keeps the master device's
	 * copy. A trailing conflict pass cleans up any CouchDB conflict leaves.
	 */
	async resolveByStrategy(path: string): Promise<void> {
		if (this.settings.conflictStrategy === "master") {
			if (this.settings.isMaster) await this.takeLocal(path);
			else await this.takeRemote(path);
		} else {
			await this.useNewest(path);
		}
		await this.resolveConflicts();
	}

	/** Overwrite the database with this device's copy (force upload). */
	async takeLocal(path: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		const hidden = isHidden(path);
		this.lastHash.delete(path);
		if (hidden) {
			if (!(await adapter.exists(path))) throw new Error("not on this device");
			const st = await adapter.stat(path);
			if (st) await this.pushPath(path, st.mtime, st.ctime, st.size);
		} else {
			const f = this.app.vault.getAbstractFileByPath(path);
			if (!(f instanceof TFile)) throw new Error("not on this device");
			await this.pushPath(path, f.stat.mtime, f.stat.ctime, f.stat.size);
		}
		await this.dropLosingRevs(path);
	}

	/**
	 * Write a reconciled text (produced by the side-by-side merge editor) as the new
	 * content of a path on BOTH sides: overwrite the local file, then upload it so the
	 * database copy matches. After this the file is fully in sync on the merged text.
	 * Text-only by design — binary drift is resolved with takeLocal / takeRemote.
	 */
	async applyMergedText(path: string, text: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		const hidden = isHidden(path);
		// Suppress the self-inflicted modify event; the upload is done explicitly below.
		this.suppress.add(path);
		this.lastHash.delete(path);
		if (hidden) {
			if (!(await adapter.exists(path))) throw new Error("not on this device");
			await adapter.write(path, text);
		} else {
			const f = this.app.vault.getAbstractFileByPath(path);
			if (!(f instanceof TFile)) throw new Error("not on this device");
			await this.app.vault.modify(f, text);
		}
		// Re-stat after the write so size/mtime match exactly what landed on disk.
		const st = await adapter.stat(path);
		if (!st) throw new Error("could not stat the merged file");
		await this.pushPath(path, st.mtime, st.ctime, st.size);
		await this.dropLosingRevs(path);
	}

	/** Delete the file on THIS device only (the database copy is kept). */
	async deleteLocalOnly(path: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		const hidden = isHidden(path);
		this.suppress.add(path); // don't let the delete event tombstone the DB
		let removed = false;
		if (hidden) {
			if (await adapter.exists(path)) {
				await adapter.remove(path);
				removed = true;
			}
		} else {
			const f = this.app.vault.getAbstractFileByPath(path);
			if (f instanceof TFile) {
				await this.app.fileManager.trashFile(f);
				removed = true;
			}
		}
		if (!removed) this.suppress.delete(path);
		this.lastHash.delete(path);
		this.forgetSynced(path);
	}

	/** Delete a file everywhere: propagate a tombstone AND remove it locally now. */
	async deleteEverywhere(path: string): Promise<void> {
		const id = FILE_PREFIX + path;
		const doc = await this.db.get(id);
		if (doc && !doc.deleted) {
			doc.deleted = true;
			doc._deleted = false; // logical tombstone (replicates the deletion)
			doc.children = [];
			doc.hash = "";
			doc.size = 0;
			doc.mtime = Date.now();
			doc.deviceId = this.settings.deviceId;
			await this.db.put(doc);
			await this.dropLosingRevs(path);
			await this.recordVersion({
				path,
				mtime: doc.mtime,
				size: 0,
				hash: "",
				binary: false,
				enc: this.settings.e2eeEnabled,
				children: [],
				deleted: true,
			});
		}
		await this.deleteLocalOnly(path);
	}

	/** Read one chunk's decrypted bytes (local, falling back to remote). */
	private async readChunkBytes(id: string): Promise<Uint8Array> {
		let chunk = await this.db.getChunkLocal(id);
		if (!chunk) {
			chunk = await this.db.getChunkRemote(id);
			if (chunk) await this.db.putChunkIfAbsent(id, chunk.enc, chunk.bytes); // cache locally
		}
		if (!chunk) throw new Error(`missing chunk ${id}`);
		return chunk.enc ? await decryptBytes(chunk.bytes, this.settings.passphrase) : chunk.bytes;
	}

	/** Desktop: write a binary file chunk-by-chunk to a temp file, then rename in. */
	private async writeBinaryStreaming(
		path: string,
		children: string[],
		adapter: FileSystemAdapter,
		hash: string
	): Promise<void> {
		const fs = nodeFs();
		const full = adapter.getFullPath(path);
		await fs.promises.mkdir(nodePath().dirname(full), { recursive: true });
		const tmp = full + TMP_SUFFIX;
		const fd = await fs.promises.open(tmp, "w");
		try {
			let done = 0;
			for (const id of children) {
				await fd.write(await this.readChunkBytes(id));
				this.activeProgress.set(path, { done: ++done, total: children.length });
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
		// Record mtime/size via Obsidian's adapter so it matches TFile.stat exactly;
		// using raw fs mtime could differ slightly and cause spurious "drift".
		const st = await adapter.stat(path);
		if (st) this.recordSynced(path, st.mtime, st.size, hash);
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
		let done = 0;
		for (const id of children) {
			parts.push(await this.readChunkBytes(id));
			this.activeProgress.set(path, { done: ++done, total: children.length });
		}
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

			const winner = pickConflictWinner(cands, this.settings.conflictStrategy, masterId);

			// Only rewrite the head when the winner differs from the content already
			// at the head. Writing a fresh revision every time is NOT idempotent:
			// two live devices resolving the same conflict would each mint a new
			// child of the base rev, producing another conflict with identical
			// content and livelocking. When the head already holds the winning
			// content we just drop the losing leaves — which converges.
			if (winner.hash !== doc.hash) {
				await this.db.put({ ...winner, _id: doc._id, _rev: doc._rev });
			}
			// ...then drop every losing leaf so the conflict is gone for good.
			for (const r of revs) {
				if (r !== doc._rev) await this.db.removeRev(doc._id, r);
			}
			this.lastHash.delete(doc.path);
			await this.applyRemoteChange({ ...winner, _rev: undefined });
		}
		this.setStatus(SYNC_STATE.SYNCED, `Resolved ${conflicted.length} conflict(s).`);
	}

	/**
	 * Resolve all current conflicts by the configured strategy WITHOUT a running
	 * session. Loads the per-device sync state up front so that materializing the
	 * winners (which calls recordSynced) cannot overwrite the persisted state map
	 * with a near-empty one, and flushes the state at the end. Safe to run on a
	 * transient engine bound to the shared DB handle. Returns the number of file
	 * docs that were conflicted going in (0 if none).
	 */
	async resolveConflictsStandalone(): Promise<number> {
		await this.loadSyncState();
		let n: number;
		try {
			n = (await this.db.getConflicted()).length;
		} catch {
			return 0;
		}
		if (n === 0) return 0;
		await this.resolveConflicts();
		await this.persistSyncState();
		return n;
	}

	// --- master coordination ----------------------------------------------

	private async publishMasterInfoIfNeeded(): Promise<void> {
		if (!this.settings.isMaster) return;
		try {
			// This doc REPLICATES to the server (other devices read it to learn who
			// the master is), so the device id must not travel in cleartext when
			// E2EE is on — encrypt it into a `meta` blob exactly like file metadata.
			if (encActive(this.settings)) {
				await this.db.putLocalDoc(MASTER_INFO_ID, {
					type: "masterinfo",
					enc: true,
					meta: await encryptString(
						JSON.stringify({ masterId: this.settings.deviceId }),
						this.settings.passphrase
					),
				});
			} else {
				await this.db.putLocalDoc(MASTER_INFO_ID, {
					type: "masterinfo",
					masterId: this.settings.deviceId,
				});
			}
		} catch {
			/* best-effort */
		}
	}

	private async getMasterId(): Promise<string | null> {
		try {
			const info = (await this.db.local.get(MASTER_INFO_ID)) as unknown as {
				masterId?: string;
				meta?: string;
			};
			if (typeof info.meta === "string") {
				if (!this.settings.passphrase) return null;
				const m = JSON.parse(await decryptString(info.meta, this.settings.passphrase)) as {
					masterId?: string;
				};
				return m.masterId ?? null;
			}
			return info.masterId ?? null;
		} catch {
			return null;
		}
	}

	// --- per-device sync state --------------------------------------------

	/** Which shard a path's record lives in. Low bits of cyrb53 → even spread. */
	private bucketOf(path: string): number {
		const h = cyrb53(path);
		return parseInt(h.slice(-8) || "0", 16) % SYNC_STATE_BUCKETS;
	}

	private recordSynced(path: string, mtime: number, size: number, hash: string): void {
		this.syncState.set(path, { mtime, size, hash });
		this.dirtyStateBuckets.add(this.bucketOf(path));
		this.saveStateSoon();
	}

	/** Forget a path's synced record (on delete) and mark its shard for rewrite. */
	private forgetSynced(path: string): void {
		this.syncState.delete(path);
		this.dirtyStateBuckets.add(this.bucketOf(path));
		this.saveStateSoon();
	}

	private async loadSyncState(): Promise<void> {
		const legacy = await this.db
			.getLocalDoc<{ records?: Record<string, SyncRecord> }>(SYNC_STATE_DOC)
			.catch(() => null);
		this.syncState = await readSyncStateRecords(this.db);
		this.dirtyStateBuckets.clear();
		// One-time migration: if the legacy single doc still holds data, re-shard every
		// path and blank the legacy doc so it is never migrated again.
		if (legacy?.records && Object.keys(legacy.records).length > 0) {
			for (const p of this.syncState.keys()) this.dirtyStateBuckets.add(this.bucketOf(p));
			await this.persistSyncState();
			await this.db.putLocalDoc(SYNC_STATE_DOC, { records: {} }).catch(() => undefined);
		}
	}

	private async persistSyncState(): Promise<void> {
		if (this.aborted) return; // DB may be closing/destroyed during teardown
		if (this.dirtyStateBuckets.size === 0) return; // nothing changed
		const buckets = [...this.dirtyStateBuckets];
		this.dirtyStateBuckets.clear();
		// Group the current records for the dirty shards only (in-memory scan is cheap;
		// the win is writing ~N/64 records to IDB instead of the whole map every time).
		const byBucket = new Map<number, Record<string, SyncRecord>>();
		for (const b of buckets) byBucket.set(b, {});
		for (const [path, rec] of this.syncState) {
			const g = byBucket.get(this.bucketOf(path));
			if (g) g[path] = rec;
		}
		try {
			for (const [b, records] of byBucket) {
				await this.db.putLocalDoc(SYNC_STATE_PREFIX + b, { records });
			}
		} catch (e) {
			// Put the shards back on the dirty list so the next flush retries them.
			for (const b of buckets) this.dirtyStateBuckets.add(b);
			if (!this.aborted) console.warn("[couchdb-sync] could not persist sync state", e);
		}
	}

	/** Index/drift report for the running session (includes hidden files). */
	getIndexReport(): Promise<IndexReport> {
		return buildIndexReport(this.app, this.settings, this.db, this.syncState);
	}
}
