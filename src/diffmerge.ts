import { Modal, Notice, setIcon } from "obsidian";
import type CouchDBSyncPlugin from "./main";
import { buildMergeBlocks, mergeResult, type MergeBlock } from "./util";

/**
 * Side-by-side diff & merge editor for a drifting/conflicting file.
 *
 * Local is always the LEFT column, the database (remote) always the RIGHT. Each
 * change block gets two arrows in the centre gutter:
 *   ▶ (right) — take the LOCAL block onto the remote (local wins this block)
 *   ◀ (left)  — take the REMOTE block onto local (remote wins this block)
 * so the user builds a merged document block by block. The header also offers
 * one-click "take every block from local / from remote" shortcuts. On apply the
 * merged text is written to BOTH sides, leaving the file fully in sync.
 *
 * Binary files (and the rare case where one side is unavailable) have no textual
 * diff — the modal then falls back to two whole-file buttons.
 */
export class DiffMergeModal extends Modal {
	private localText: string | null = null;
	private remoteText: string | null = null;
	private blocks: MergeBlock[] = [];
	private bodyEl?: HTMLElement;
	private applying = false;

	constructor(
		private plugin: CouchDBSyncPlugin,
		private path: string,
		private onResolved: () => void
	) {
		super(plugin.app);
	}

	async onOpen(): Promise<void> {
		this.modalEl.addClass("couchdb-sync-merge-modal");
		this.titleEl.setText(`Diff — ${this.path}`);
		this.contentEl.setText("Loading…");
		try {
			[this.localText, this.remoteText] = await Promise.all([
				this.plugin.getLocalText(this.path),
				this.plugin.getRemoteText(this.path),
			]);
		} catch (e) {
			this.contentEl.setText(`Could not load the file: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}

		// No line diff possible (binary, or one side missing) -> whole-file fallback.
		if (this.localText === null || this.remoteText === null) {
			this.renderBinaryFallback();
			return;
		}

		this.blocks = buildMergeBlocks(this.localText, this.remoteText);
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private changeBlocks(): Extract<MergeBlock, { type: "change" }>[] {
		return this.blocks.filter((b): b is Extract<MergeBlock, { type: "change" }> => b.type === "change");
	}

	// --- whole-file fallback (binary / one side unavailable) -------------------

	private renderBinaryFallback(): void {
		const { contentEl } = this;
		contentEl.empty();
		const why =
			this.localText === null && this.remoteText === null
				? "Neither side is available as text."
				: "This file is binary (or one side is unavailable), so it has no line-by-line diff.";
		contentEl.createEl("p", { text: `${why} Choose which copy to keep everywhere:`, cls: "couchdb-sync-diff-note" });
		const row = contentEl.createDiv({ cls: "couchdb-sync-modal-buttons" });

		const localBtn = row.createEl("button", { text: "Keep local (this device) ▶", cls: "mod-cta" });
		localBtn.onclick = () => this.finish(() => this.plugin.takeLocalPath(this.path), "kept the local copy everywhere");

		const remoteBtn = row.createEl("button", { text: "◀ Keep remote (database)" });
		remoteBtn.onclick = () => this.finish(() => this.plugin.takeRemotePath(this.path), "kept the database copy everywhere");
	}

	// --- side-by-side merge editor --------------------------------------------

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();

		const changes = this.changeBlocks();

		// --- header: legend + whole-file "take all" shortcuts ---
		const header = contentEl.createDiv({ cls: "couchdb-sync-merge-header" });
		const legend = header.createDiv({ cls: "couchdb-sync-merge-legend" });
		legend.createSpan({ cls: "couchdb-sync-merge-side-tag couchdb-sync-merge-local", text: "Local (this device)" });
		legend.createSpan({ cls: "couchdb-sync-merge-side-tag couchdb-sync-merge-remote", text: "Remote (database)" });
		legend.createSpan({
			cls: "couchdb-sync-merge-count",
			text: changes.length === 1 ? "1 change block" : `${changes.length} change blocks`,
		});

		const actions = header.createDiv({ cls: "couchdb-sync-merge-actions" });
		const allLocal = actions.createEl("button", { text: "Take all local ▶", cls: "couchdb-sync-merge-allbtn" });
		allLocal.ariaLabel = "Every block: keep the local version (upload local to the database)";
		allLocal.onclick = () => this.setAll("local");
		const allRemote = actions.createEl("button", { text: "◀ Take all remote", cls: "couchdb-sync-merge-allbtn" });
		allRemote.ariaLabel = "Every block: keep the remote version (download the database copy)";
		allRemote.onclick = () => this.setAll("remote");

		// --- diff body ---
		this.bodyEl = contentEl.createDiv({ cls: "couchdb-sync-merge-body" });
		this.renderBody();

		// --- footer: apply / cancel ---
		const footer = contentEl.createDiv({ cls: "couchdb-sync-modal-buttons couchdb-sync-merge-footer" });
		const cancel = footer.createEl("button", { text: "Cancel" });
		cancel.onclick = () => this.close();
		const apply = footer.createEl("button", { text: "Apply merge", cls: "mod-cta" });
		apply.onclick = () => this.apply();

		if (changes.length === 0) {
			// Content decodes identically on both sides — the drift is metadata-only.
			const note = contentEl.createEl("p", { cls: "couchdb-sync-diff-note" });
			note.setText("No textual differences — the two copies decode to the same text. Applying will simply re-sync the file.");
		}
	}

	private setAll(choice: "local" | "remote"): void {
		for (const b of this.blocks) if (b.type === "change") b.choice = choice;
		this.renderBody();
	}

	private renderBody(): void {
		const body = this.bodyEl;
		if (!body) return;
		body.empty();

		// Running 1-based line numbers per side (VS Code-style gutter).
		let ln = 0;
		let rn = 0;

		for (const block of this.blocks) {
			if (block.type === "equal") {
				const rowsWrap = body.createDiv({ cls: "couchdb-sync-merge-block is-equal" });
				for (const line of block.lines) {
					ln++; rn++;
					this.lineRow(rowsWrap, ln, line, rn, line, "eq", "eq");
				}
				continue;
			}

			const wrap = body.createDiv({ cls: `couchdb-sync-merge-block is-change choice-${block.choice}` });
			const n = Math.max(block.local.length, block.remote.length);
			for (let i = 0; i < n; i++) {
				const l = block.local[i];
				const r = block.remote[i];
				const lNum = l !== undefined ? ++ln : null;
				const rNum = r !== undefined ? ++rn : null;
				const leftCls = l === undefined ? "pad" : block.choice === "local" ? "kept" : "dropped";
				const rightCls = r === undefined ? "pad" : block.choice === "remote" ? "kept" : "dropped";
				this.lineRow(wrap, lNum, l ?? "", rNum, r ?? "", leftCls, rightCls);
			}

			// Centre gutter with the two directional apply arrows for this block.
			const gutter = wrap.createDiv({ cls: "couchdb-sync-merge-gutter" });
			const right = gutter.createEl("button", { cls: "couchdb-sync-merge-arrow" + (block.choice === "local" ? " is-active" : "") });
			setIcon(right, "arrow-right");
			right.ariaLabel = "Keep the local version of this block (local ▶ remote)";
			right.onclick = () => { block.choice = "local"; this.renderBody(); };
			const left = gutter.createEl("button", { cls: "couchdb-sync-merge-arrow" + (block.choice === "remote" ? " is-active" : "") });
			setIcon(left, "arrow-left");
			left.ariaLabel = "Keep the remote version of this block (remote ◀ local)";
			left.onclick = () => { block.choice = "remote"; this.renderBody(); };
		}
	}

	/** One aligned row: [left line-no][left text][right line-no][right text]. */
	private lineRow(
		parent: HTMLElement,
		lNum: number | null,
		lText: string,
		rNum: number | null,
		rText: string,
		leftCls: string,
		rightCls: string
	): void {
		const row = parent.createDiv({ cls: "couchdb-sync-merge-row" });
		row.createSpan({ cls: "couchdb-sync-merge-lno", text: lNum === null ? "" : String(lNum) });
		row.createDiv({ cls: `couchdb-sync-merge-cell cdl-${leftCls}`, text: lText === "" ? " " : lText });
		row.createSpan({ cls: "couchdb-sync-merge-lno", text: rNum === null ? "" : String(rNum) });
		row.createDiv({ cls: `couchdb-sync-merge-cell cdl-${rightCls}`, text: rText === "" ? " " : rText });
	}

	// --- apply -----------------------------------------------------------------

	private async apply(): Promise<void> {
		const merged = mergeResult(this.blocks);
		// Reuse the tested whole-file paths when the merge collapses to one side; only
		// a genuinely mixed result needs the write-both-sides merge path.
		if (merged === this.localText) {
			await this.finish(() => this.plugin.takeLocalPath(this.path), "applied — local copy kept, database updated");
		} else if (merged === this.remoteText) {
			await this.finish(() => this.plugin.takeRemotePath(this.path), "applied — remote copy taken onto this device");
		} else {
			await this.finish(() => this.plugin.applyMergedTextPath(this.path, merged), "applied the merged result to both sides");
		}
	}

	private async finish(action: () => Promise<void>, okMsg: string): Promise<void> {
		if (this.applying) return;
		this.applying = true;
		try {
			await action();
			new Notice(`CouchDB Sync: ${okMsg}.`);
			this.onResolved();
			this.close();
		} catch (e) {
			this.applying = false;
			new Notice(`CouchDB Sync: could not apply — ${e instanceof Error ? e.message : String(e)}`);
		}
	}
}
