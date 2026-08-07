import { ItemView, WorkspaceLeaf } from "obsidian";
import type CouchDBSyncPlugin from "./main";
import { IndexPanel } from "./indexpanel";

export const VIEW_TYPE_SYNC_STATUS = "couchdb-sync-status";

/**
 * The sync status as a right-sidebar view.
 *
 * It mounts the very same {@link IndexPanel} the settings tab embeds, so the
 * status card, the per-state lists, the file tree and every per-file action
 * behave identically in both places — there is one implementation, not a
 * read-only copy that slowly drifts from the real thing.
 *
 * Timers only run while the view is open: `onClose` unmounts the panel, so a
 * sidebar the user has closed costs nothing.
 */
export class SyncStatusView extends ItemView {
	private plugin: CouchDBSyncPlugin;
	private panel: IndexPanel;

	constructor(leaf: WorkspaceLeaf, plugin: CouchDBSyncPlugin) {
		super(leaf);
		this.plugin = plugin;
		// The sidebar is the full view: status + store widgets + attention list + trees.
		this.panel = new IndexPanel(plugin, "full");
	}

	getViewType(): string {
		return VIEW_TYPE_SYNC_STATUS;
	}

	getDisplayText(): string {
		return "CouchDB Sync";
	}

	getIcon(): string {
		return "refresh-cw";
	}

	// ItemView declares these as returning a promise, but mounting and unmounting
	// the panel is synchronous — `async` here only promised an await that never came.
	onOpen(): Promise<void> {
		const host = this.contentEl;
		host.empty();
		host.addClass("couchdb-sync-view");
		this.panel.mount(host.createDiv({ cls: "couchdb-sync-panel-host" }));
		return Promise.resolve();
	}

	onClose(): Promise<void> {
		this.panel.unmount();
		this.contentEl.empty();
		return Promise.resolve();
	}
}
