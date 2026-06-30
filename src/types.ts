export type ConflictStrategy = "master" | "newest";

export interface CouchDBSyncSettings {
	/** e.g. https://couch.example.com:6984 */
	serverUrl: string;
	/** remote database name */
	dbName: string;
	username: string;
	password: string;

	/** end-to-end encryption of document content (at rest on the server) */
	e2eeEnabled: boolean;
	/** shared secret; MUST match on every device. Never replicated. */
	passphrase: string;

	/** how conflicts are resolved automatically, without prompting */
	conflictStrategy: ConflictStrategy;
	/** when conflictStrategy === "master", this device's writes win */
	isMaster: boolean;

	/** stable per-install id (auto-generated) */
	deviceId: string;

	/**
	 * Stable, random per-VAULT id used to name the local PouchDB so two vaults on
	 * the same machine can never share their local replica. Auto-generated on
	 * first load; persisted in data.json (which lives inside each vault's
	 * .obsidian/plugins/couchdb-sync/, so it is already vault-scoped). Adding the
	 * random component guarantees uniqueness even across vaults that happen to
	 * have the same name or path.
	 */
	localDbId: string;

	/** whether live (continuous) sync is enabled */
	liveSync: boolean;

	/** start synchronizing automatically when Obsidian launches */
	autoStart: boolean;

	/**
	 * Sync hidden files (dotfiles and dot-folders like .obsidian, .git). Normal files
	 * are always synced. Our own plugin's data.json is always excluded.
	 */
	syncHidden: boolean;

	/** when syncHidden is ON: hidden paths to NOT sync (blacklist) */
	hiddenExclude: string[];

	/** when syncHidden is OFF: hidden paths to sync anyway (whitelist) */
	hiddenInclude: string[];

	/**
	 * How many past versions to keep per file in the explicit history log. Content
	 * chunks are content-addressed and shared, so history mostly costs small metadata.
	 */
	keepHistory: number;

	/**
	 * Show excluded files (matched by the skip rules) in the Sync state tree so they
	 * can be inspected and synced once on demand. Off by default; bounded — only
	 * excluded files that already exist as normal vault files or as database docs are
	 * listed (never a full walk of .git/node_modules).
	 */
	showExcluded: boolean;

	/**
	 * Crash guard. Set to true while a sync session is starting/running and cleared
	 * once it reaches a safe steady state. If it is still true at launch, the previous
	 * session did not finish cleanly (hang/crash), so we start in safe mode (no
	 * auto-start) to keep the recovery buttons reachable.
	 */
	unsafeShutdown: boolean;

	/**
	 * Set true once we have proven the configured server+credentials are valid
	 * (Test connection succeeded, or a sync session reached steady state). Gates
	 * the index status view so users cannot accidentally inspect the local cache
	 * by typing random text into the URL field — that cache may legitimately
	 * exist from a previous configuration, but its contents should not be shown
	 * until the user has demonstrated control of the matching remote.
	 */
	connectionVerified: boolean;

	/**
	 * Privacy mode: destroy the local PouchDB on plugin disable / unload, so the
	 * cached file metadata is not left behind on the machine when the user turns
	 * the plugin off. Trade-off: re-enabling forces a full re-replication from
	 * the server (no warm cache). Off by default.
	 */
	forgetCacheOnDisable: boolean;
}

export const DEFAULT_SETTINGS: CouchDBSyncSettings = {
	serverUrl: "",
	dbName: "obsidian",
	username: "",
	password: "",
	e2eeEnabled: true, // encryption on by default
	passphrase: "",
	conflictStrategy: "newest",
	isMaster: false,
	deviceId: "",
	localDbId: "",
	liveSync: true,
	autoStart: true,
	syncHidden: false,
	// when hidden sync is ON, keep these volatile/risky hidden paths out
	hiddenExclude: [
		".obsidian/",
		".git/",
		".trash/",
		".DS_Store",
		"node_modules/",
		".claude/",
		"tmp/",
		".obsidian/workspace.json",
		".obsidian/workspace-mobile.json",
		".obsidian/cache",
	],
	// when hidden sync is OFF, sync nothing hidden by default
	hiddenInclude: [],
	keepHistory: 50,
	showExcluded: false,
	unsafeShutdown: false,
	connectionVerified: false,
	forgetCacheOnDisable: false,
};

/**
 * One CouchDB document per vault file. The content itself lives in separate,
 * content-addressed chunk documents; this doc only holds metadata and the ordered
 * list of chunk ids. That keeps every document small (no matter how big the file)
 * and lets unchanged chunks be reused. `_id` is the vault-relative path.
 */
export interface FileDoc {
	_id: string;
	_rev?: string;
	_deleted?: boolean;
	_conflicts?: string[];

	type: "file";
	path: string;
	mtime: number;
	ctime: number;
	size: number;

	/** logical deletion (tombstone) so deletes replicate cleanly */
	deleted: boolean;

	/** originating device — used by the "master wins" strategy */
	deviceId: string;

	/** true when the file is binary (chunks are base64 of raw bytes) */
	binary: boolean;

	/** true when chunk payloads are encrypted */
	enc: boolean;

	/** ordered list of chunk document ids; empty for an empty file */
	children: string[];

	/** cheap fingerprint of the content (hash of the ordered children) */
	hash: string;
}

/**
 * One immutable entry in a file's explicit version history. We keep history
 * ourselves (instead of relying on PouchDB `_rev` history, which compaction and a
 * low `_revs_limit` prune away) so the timeline is always complete and restorable.
 *
 * `_id` is "H:" + path + "\n" + zero-padded timestamp + "\n" + short hash. The
 * newline delimiter cannot appear in a vault path, so a path-prefixed range query
 * is unambiguous; the padded timestamp makes the lexicographic order chronological.
 * History docs replicate like any other doc, so every device shares one timeline.
 * They sort BEFORE the "f:" file docs and "h:" chunks, so file-doc range scans
 * never see them.
 */
export interface VersionDoc {
	_id: string;
	_rev?: string;
	_deleted?: boolean;

	type: "version";
	path: string;
	/** when this version was committed (ms since epoch) */
	ts: number;
	mtime: number;
	size: number;
	hash: string;
	deviceId: string;
	binary: boolean;
	enc: boolean;
	/** ordered chunk ids of this version (empty for a deletion entry) */
	children: string[];
	/** true when this entry records a deletion */
	deleted: boolean;
	/** optional human note, e.g. "restored from <date>" */
	note?: string;
}

/**
 * A content-addressed chunk. `_id` is "h:" + a hash of the chunk, so identical
 * content always maps to the same document and is stored once. Chunks are
 * immutable (never updated), which means they never produce sync conflicts.
 */
export interface ChunkDoc {
	_id: string;
	_rev?: string;
	type: "chunk";
	/** true when `data` is encrypted */
	enc: boolean;
	/** base64 of the raw chunk bytes, encrypted when enc=true */
	data: string;
}

/** Per-device record of the last successfully synced state of a file (not replicated). */
export interface SyncRecord {
	mtime: number;
	size: number;
	hash: string;
}

export const SYNC_STATE = {
	IDLE: "idle",
	CONNECTING: "connecting",
	SYNCING: "syncing",
	SYNCED: "synced",
	OFFLINE: "offline",
	PAUSED: "paused",
	ERROR: "error",
} as const;

export type SyncState = (typeof SYNC_STATE)[keyof typeof SYNC_STATE];

/** Current sync status, shared with the status bar and the settings view. */
export interface SyncStatus {
	state: SyncState;
	detail?: string;
	/** progress of the current indexing pass, when applicable */
	done?: number;
	total?: number;
}

/** Raw chunk size in bytes before base64/encryption. Keeps documents well-sized. */
export const CHUNK_SIZE = 1024 * 1024; // 1 MiB

/**
 * Document id prefixes. File metadata docs are keyed "f:" + path; chunks are "h:" + hash.
 * The prefix lets us range-query ONLY the (small) file docs and never load chunk data
 * into memory by accident — which would otherwise blow up RAM on large vaults.
 */
export const FILE_PREFIX = "f:";
export const CHUNK_PREFIX = "h:";
/** History/version docs. Sorts before "f:" so file-doc range scans skip them. */
export const HISTORY_PREFIX = "H:";
/** Delimiter inside a history id; a newline can never appear in a vault path. */
export const HISTORY_SEP = "\n";
