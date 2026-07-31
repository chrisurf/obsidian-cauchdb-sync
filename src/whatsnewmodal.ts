import { App, Component, MarkdownRenderer, Modal, Setting } from "obsidian";
import {
	WHATS_NEW,
	HERO_IMAGE_URL,
	BUY_ME_A_COFFEE_URL,
	BUY_ME_A_COFFEE_IMAGE_URL,
} from "./whatsnew";

/**
 * Introduces the latest functionality after an install or an update. It renders
 * the curated {@link WHATS_NEW} markdown and offers to open the sync status
 * panel straight away, so what it describes is one click from being tried.
 */
export class WhatsNewModal extends Modal {
	private readonly version: string;
	private readonly component: Component;
	private readonly onOpenPanel: () => void;

	constructor(app: App, version: string, component: Component, onOpenPanel: () => void) {
		super(app);
		this.version = version;
		this.component = component;
		this.onOpenPanel = onOpenPanel;
	}

	onOpen(): void {
		const { contentEl, titleEl, modalEl } = this;
		modalEl.addClass("couchdb-sync-whats-new-modal");
		titleEl.setText(`What's new in CouchDB Sync ${this.version}`);

		// Hero banner, mirroring the README. Fetched from GitHub, so it is hidden
		// rather than left as a broken image when the vault is offline.
		const hero = contentEl.createEl("img", {
			cls: "couchdb-sync-whats-new-hero",
			attr: { alt: "CouchDB Sync for Obsidian", src: HERO_IMAGE_URL },
		});
		hero.addEventListener("error", () => hero.hide());

		// "Buy me a coffee", directly under the hero, the same order the README has.
		// The button is a remote image too, but the LINK does not depend on it: if the
		// image cannot be fetched (offline, or the asset not yet published on main) the
		// anchor stays and falls back to a plain text button. Hiding the whole row on a
		// failed image meant the one place this plugin asks for support disappeared
		// exactly when the images were not live yet.
		const support = contentEl.createDiv({ cls: "couchdb-sync-whats-new-support" });
		const coffeeLink = support.createEl("a", {
			cls: "couchdb-sync-bmc-link",
			attr: { href: BUY_ME_A_COFFEE_URL, target: "_blank", rel: "noopener" },
		});
		const coffeeImg = coffeeLink.createEl("img", {
			cls: "couchdb-sync-bmc-button",
			attr: { alt: "Buy me a coffee", src: BUY_ME_A_COFFEE_IMAGE_URL },
		});
		coffeeImg.addEventListener("error", () => {
			coffeeImg.remove();
			coffeeLink.addClass("couchdb-sync-bmc-fallback");
			coffeeLink.setText("☕ Buy me a coffee");
		});

		const body = contentEl.createDiv({ cls: "couchdb-sync-whats-new-body" });
		// The component ties the rendered children to the plugin's lifecycle, so
		// they are unloaded with it rather than left behind.
		void MarkdownRenderer.render(this.app, WHATS_NEW, body, "", this.component);

		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText("Open sync status panel")
					.setCta()
					.onClick(() => {
						this.onOpenPanel();
						this.close();
					})
			)
			.addButton((btn) => btn.setButtonText("Close").onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
