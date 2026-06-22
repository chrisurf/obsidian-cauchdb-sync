import { App, EventRef, TFile, TFolder, normalizePath, debounce } from "obsidian";
import { SyncDatabase } from "./database";
import { decryptString, encryptString } from "./crypto";
import { CouchDBSyncSettings, FileDoc, SYNC_STATE, SyncState } from "./types";
import {
	arrayBufferToBase64,
	base64ToArrayBuffer,
	cyrb53,
	isBinaryPath,
	matchesIgnore,
} from "./util";

const MASTER_INFO_ID = "couchdb-sync:masterinfo";

type StatusFn = (state: SyncState, detail?: string) => void;

export class SyncEngine {
	private app: App;
	private db: SyncDatabase;
	private settings: CouchDBSyncSettings;
	private setStatus: StatusFn;

	private syncHandler: PouchDB.Replication.Sync<FileDoc> | null = null;
	private eventRefs: EventRef[] = [];

	/** path -> hash of last content we read-from or wrote-to the vault (echo guard) */
	private lastHash = new Map<string, string>();
	/** paths we are about to write ourselves; their next vault event is ignored */
	private suppress = new Set<string>();

	private resolveSoon = debounce(() => void this.resolveConflicts(), 800, false);

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
			.on("denied", (err) => this.setStatus(SYNC_STATE.ERROR, String(err)))
			.on("error", (err) => this.setStatus(SYNC_STATE.ERROR, String(err)));
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
			this.setStatus(SYNC_STATE.ERROR, String(e));
		}
	}

	private async applyPulledDocs(docs: FileDoc[]): Promise<void> {
		for (const doc of docs) {
			if (!doc || doc.type !== "file") continue;
			await this.applyRemoteChange(doc);
		}
		this.resolveSoon();
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
			const doc = docByPath.get(file.path);
			if (!doc) {
				await this.pushFile(file);
			} else if (!doc.deleted) {
				const raw = await this.readLocal(file);
				if (cyrb53(raw) !== (await this.docContentHash(doc))) {
					await this.pushFile(file); // local differs; conflict pass will settle ties
				} else {
					this.lastHash.set(file.path, cyrb53(raw));
				}
			}
		}

		// 2) docs present in DB but missing locally -> create or honor tombstone
		for (const doc of docs) {
			if (localByPath.has(doc._id)) continue;
			await this.applyRemoteChange(doc);
		}

		await this.resolveConflicts();
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
		await this.pushFile(file);
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
		doc.data = "";
		doc.size = 0;
		doc.mtime = Date.now();
		doc.deviceId = this.settings.deviceId;
		await this.db.put(doc);
		this.lastHash.delete(path);
	}

	private async pushFile(file: TFile): Promise<void> {
		const raw = await this.readLocal(file);
		const hash = cyrb53(raw);
		if (this.lastHash.get(file.path) === hash) return; // unchanged / our own echo
		this.lastHash.set(file.path, hash);

		const binary = isBinaryPath(file.path);
		let data = raw;
		let enc = false;
		if (this.settings.e2eeEnabled) {
			if (!this.settings.passphrase) {
				this.setStatus(SYNC_STATE.ERROR, "Encryption is on but no passphrase is set.");
				return;
			}
			data = await encryptString(raw, this.settings.passphrase);
			enc = true;
		}

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
			binary,
			enc,
			data,
		};
		await this.db.put(doc);
	}

	private async readLocal(file: TFile): Promise<string> {
		if (isBinaryPath(file.path)) {
			return arrayBufferToBase64(await this.app.vault.readBinary(file));
		}
		return this.app.vault.read(file);
	}

	// --- db -> local -------------------------------------------------------

	private async applyRemoteChange(doc: FileDoc): Promise<void> {
		const path = doc.path || doc._id;
		if (matchesIgnore(path, this.settings.ignorePatterns)) return;

		const existing = this.app.vault.getAbstractFileByPath(path);

		if (doc.deleted) {
			if (existing instanceof TFile) {
				this.suppress.add(path);
				this.lastHash.delete(path);
				await this.app.fileManager.trashFile(existing);
			}
			return;
		}

		let raw: string;
		try {
			raw = doc.enc ? await decryptString(doc.data, this.settings.passphrase) : doc.data;
		} catch (e) {
			this.setStatus(SYNC_STATE.ERROR, (e as Error).message);
			return;
		}
		const hash = cyrb53(raw);

		// skip if local already has identical content
		if (existing instanceof TFile) {
			const current = await this.readLocal(existing);
			if (cyrb53(current) === hash) {
				this.lastHash.set(path, hash);
				return;
			}
		}

		this.lastHash.set(path, hash);
		this.suppress.add(path);
		await this.ensureFolder(path);

		if (doc.binary) {
			const buf = base64ToArrayBuffer(raw);
			if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, buf);
			else await this.app.vault.createBinary(path, buf);
		} else {
			if (existing instanceof TFile) await this.app.vault.modify(existing, raw);
			else await this.app.vault.create(path, raw);
		}
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
			await this.applyRemoteChange({ ...winner, _rev: undefined });
		}
		this.setStatus(SYNC_STATE.SYNCED, `Resolved ${conflicted.length} conflict(s).`);
	}

	// --- master coordination ----------------------------------------------

	private async publishMasterInfoIfNeeded(): Promise<void> {
		if (!this.settings.isMaster) return;
		try {
			const existing = (await this.db.local
				.get(MASTER_INFO_ID)
				.catch(() => null)) as { _rev?: string } | null;
			// control document (not a FileDoc) — written via the untyped handle
			await (this.db.local as unknown as PouchDB.Database).put({
				_id: MASTER_INFO_ID,
				_rev: existing?._rev,
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

	private async docContentHash(doc: FileDoc): Promise<string> {
		try {
			const raw = doc.enc
				? await decryptString(doc.data, this.settings.passphrase)
				: doc.data;
			return cyrb53(raw);
		} catch {
			return " decrypt-error";
		}
	}
}
