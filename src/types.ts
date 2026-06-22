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
};

/**
 * One CouchDB document per vault file. For the MVP the content is stored
 * inline (chunking comes in a later phase). `_id` is the vault-relative path.
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

	/** true when `data` is base64-encoded binary content */
	binary: boolean;

	/** true when `data` is encrypted (see crypto.ts payload format) */
	enc: boolean;

	/** file content: utf-8 text or base64 (binary), encrypted when enc=true */
	data: string;
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
