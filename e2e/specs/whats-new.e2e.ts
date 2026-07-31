import { browser } from "@wdio/globals";
import { describe, it, before, after } from "mocha";
import assert from "node:assert/strict";
import { PLUGIN_ID } from "./helpers.js";

/**
 * The "what's new" note. It is the first thing a new install sees, and its two
 * decorations — the hero banner and the "buy me a coffee" link right under it —
 * are loaded from GitHub rather than bundled. Remote assets fail quietly, so the
 * order and the presence of both are asserted here: a broken image must never
 * take the support link down with it.
 */

interface ModalSnapshot {
	present: boolean;
	title: string;
	heroSrc: string | null;
	/** index of the hero and of the support row among the modal's children */
	heroIndex: number;
	supportIndex: number;
	coffeeHref: string | null;
	bodyHasHeadings: boolean;
	buttons: string[];
}

function snapshotWhatsNew(): Promise<ModalSnapshot> {
	return browser.executeObsidian(async ({ app }, id) => {
		const commands = (app as unknown as { commands: { executeCommandById(i: string): boolean } })
			.commands;
		commands.executeCommandById(`${id}:whats-new`);
		// Let the modal mount and the markdown render.
		await new Promise((r) => setTimeout(r, 300));

		const modal = document.querySelector(".couchdb-sync-whats-new-modal");
		if (!modal) {
			return {
				present: false,
				title: "",
				heroSrc: null,
				heroIndex: -1,
				supportIndex: -1,
				coffeeHref: null,
				bodyHasHeadings: false,
				buttons: [],
			};
		}
		const content = modal.querySelector(".modal-content") ?? modal;
		const kids = Array.from(content.children);
		const hero = content.querySelector("img.couchdb-sync-whats-new-hero");
		const support = content.querySelector(".couchdb-sync-whats-new-support");
		const coffee = content.querySelector("a.couchdb-sync-bmc-link");
		return {
			present: true,
			title: modal.querySelector(".modal-title")?.textContent ?? "",
			heroSrc: hero?.getAttribute("src") ?? null,
			heroIndex: hero ? kids.indexOf(hero) : -1,
			supportIndex: support ? kids.indexOf(support) : -1,
			coffeeHref: coffee?.getAttribute("href") ?? null,
			bodyHasHeadings:
				(content.querySelectorAll(".couchdb-sync-whats-new-body h2").length ?? 0) > 0,
			buttons: Array.from(content.querySelectorAll("button")).map((b) => b.textContent ?? ""),
		};
	}, PLUGIN_ID);
}

describe("CouchDB Sync — what's new modal", function () {
	let snap: ModalSnapshot;

	before(async function () {
		snap = await snapshotWhatsNew();
	});

	after(async function () {
		await browser.executeObsidian(() => {
			document.querySelectorAll(".modal-close-button").forEach((b) => (b as HTMLElement).click());
		});
	});

	it("opens from the command palette", async function () {
		assert.ok(snap.present, "the what's new modal did not open");
		assert.match(snap.title, /What's new in CouchDB Sync/);
	});

	it("shows the hero image at the top", async function () {
		assert.ok(snap.heroSrc, "no hero image element in the modal");
		assert.match(snap.heroSrc ?? "", /\/assets\/hero\.png$/);
		assert.match(snap.heroSrc ?? "", /chrisurf\/obsidian-cauchdb-sync/);
		assert.equal(snap.heroIndex, 0, "the hero must be the first thing in the modal");
	});

	it("puts the buy-me-a-coffee link directly after the hero", async function () {
		assert.equal(snap.coffeeHref, "https://www.buymeacoffee.com/chrisurf");
		assert.equal(
			snap.supportIndex,
			snap.heroIndex + 1,
			"the support row must follow the hero immediately"
		);
	});

	it("renders the release note itself and the two actions", async function () {
		assert.ok(snap.bodyHasHeadings, "the markdown body rendered no headings");
		assert.ok(
			snap.buttons.some((b) => b.includes("Open sync status panel")),
			`expected a panel button; had: ${snap.buttons.join(", ")}`
		);
		assert.ok(snap.buttons.some((b) => b.includes("Close")), "expected a close button");
	});
});
