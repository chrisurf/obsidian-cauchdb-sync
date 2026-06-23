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

	/** glob-ish path prefixes to never sync */
	ignorePatterns: string[];

	/** whether live (continuous) sync is enabled */
	liveSync: boolean;

	/** start synchronizing automatically when Obsidian launches */
	autoStart: boolean;

	/**
	 * Crash guard. Set to true while a sync session is starting/running and cleared
	 * once it reaches a safe steady state. If it is still true at launch, the previous
	 * session did not finish cleanly (hang/crash), so we start in safe mode (no
	 * auto-start) to keep the recovery buttons reachable.
	 */
	unsafeShutdown: boolean;
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
	ignorePatterns: [".obsidian/", ".trash/", ".git/"],
	liveSync: true,
	autoStart: true,
	unsafeShutdown: false,
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

/** Raw chunk size in bytes before base64/encryption. Keeps documents well-sized. */
export const CHUNK_SIZE = 1024 * 1024; // 1 MiB

/**
 * Document id prefixes. File metadata docs are keyed "f:" + path; chunks are "h:" + hash.
 * The prefix lets us range-query ONLY the (small) file docs and never load chunk data
 * into memory by accident — which would otherwise blow up RAM on large vaults.
 */
export const FILE_PREFIX = "f:";
export const CHUNK_PREFIX = "h:";
