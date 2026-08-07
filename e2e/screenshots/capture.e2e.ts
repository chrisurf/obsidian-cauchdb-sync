import { browser } from "@wdio/globals";
import { describe, it, before } from "mocha";
import { PLUGIN_ID } from "../specs/helpers.js";

/**
 * PROTOTYPE screenshot capture — proof that the existing E2E harness
 * (wdio-obsidian-service driving a REAL Obsidian) can produce documentation
 * screenshots of the actual plugin, on demand, deterministically.
 *
 * It lives OUTSIDE e2e/specs/** on purpose, so it never runs in the normal test
 * suite. Invoke it explicitly:
 *   OBSIDIAN_VERSIONS="latest/latest" WDIO_MAX_INSTANCES=1 \
 *     npx wdio run ./wdio.conf.mts --spec ./e2e/screenshots/capture.e2e.ts
 *
 * Output PNGs land in docs/screenshots/.
 *
 * Note: Obsidian's Electron chromedriver does NOT support window resizing
 * (Browser.getWindowForTarget). So instead of resizing the window, we mount the
 * plugin's own panel into a throwaway container of a fixed width and take an
 * ELEMENT screenshot — 420px reproduces the mobile single-column layout, ~920px
 * the desktop layout. Same panel code, deterministic width, no device needed.
 */
const OUT = "docs/screenshots";

type CapturePanel = { mount(root: HTMLElement): void; unmount(): void };

describe("CouchDB Sync — documentation screenshots (prototype)", function () {
	before(async function () {
		// Configure just enough that the panel is not privacy-gated; keep sync OFF so
		// no network is touched. The fixture vault's files render as the live state.
		await browser.executeObsidian(async ({ app }, id) => {
			const plugin = (
				app as unknown as { plugins: { plugins: Record<string, {
					settings: Record<string, unknown>; saveSettings(): Promise<void>;
					revealStatusView(): Promise<void>;
				}> } }
			).plugins.plugins[id];
			plugin.settings.serverUrl = "https://couch.example.com";
			plugin.settings.dbName = "demo-vault";
			plugin.settings.username = "demo";
			plugin.settings.connectionVerified = true;
			plugin.settings.syncEnabled = false;
			plugin.settings.e2eeEnabled = false;
			await plugin.saveSettings();
		}, PLUGIN_ID);

		// Seed a realistic vault for a CREATIVE VIDEO-EDITING Obsidian user, at runtime,
		// so the screenshots read like a real workflow. This touches only the running
		// test instance's vault — the committed fixture (e2e/vaults/simple) is untouched.
		await browser.executeObsidian(async ({ app }) => {
			const vault = (app as unknown as {
				vault: {
					getAbstractFileByPath(p: string): unknown;
					getRoot(): { children: { name: string }[] };
					createFolder(p: string): Promise<unknown>;
					create(p: string, data: string): Promise<unknown>;
					delete(f: unknown, force?: boolean): Promise<unknown>;
				};
			}).vault;
			// Remove the default fixture entries so the screenshot shows ONLY the
			// video-editing vault. Hidden folders (e.g. .obsidian) are left in place.
			for (const child of [...vault.getRoot().children]) {
				if (!child.name.startsWith(".")) {
					await vault.delete(child, true).catch(() => undefined);
				}
			}
			const files: Record<string, string> = {
				"Projects/acme-summer-promo.md":
					"# ACME — Summer Promo\n\n- Deliverables: 30s hero, 15s + 6s cutdowns, 9:16 reel\n- Timeline: Resolve `ACME_promo_v7`\n- Status: color pass ➜ client review\n",
				"Projects/travel-vlog-iceland.md":
					"# Travel Vlog — Iceland\n\n- 4K60 HLG, ~2.1 TB footage\n- Music: licensed (see Assets)\n- Cut: 12:40 ➜ target 9:00\n",
				"Clients/acme-brand-guidelines.md":
					"# ACME — Brand Guidelines\n\n- LUT: `ACME_house.cube`\n- Lower-thirds font: Sohne\n- Logo safe-area: 8%\n",
				"Scripts/product-launch-voiceover.md":
					"# VO — Product Launch\n\n> \"Meet the camera that keeps up with you...\"\n\n- Runtime: 0:45\n- Talent: Mara (booked Tue)\n",
				"Shot Lists/wedding-riverside-shotlist.md":
					"# Shot List — Riverside Wedding\n\n- [ ] Ceremony wide (A-cam)\n- [ ] Ring macro (100mm)\n- [ ] Golden-hour couple B-roll\n- [ ] Drone establishing\n",
				"Editing/davinci-resolve-shortcuts.md":
					"# Resolve Shortcuts\n\n- Blade: `B` · Ripple delete: `Shift+Del`\n- Retime: `R` · Dynamic zoom: `Alt+Z`\n- Power grade copy: middle-click node\n",
				"Editing/color-grading-notes.md":
					"# Color Notes\n\n- Base: Rec.709 @ 2.4 gamma\n- Skin: keep in the vector line\n- Halation on speculars (subtle)\n",
				"Assets/music-licenses.md":
					"# Music Licenses\n\n| Track | Source | License |\n|---|---|---|\n| Neon Drive | Artlist | ✔ commercial |\n| Slow Tide | Musicbed | ✔ per-project |\n",
				"Assets/broll-inventory.md":
					"# B-Roll Inventory\n\n- City / night / neon — 37 clips\n- Nature / water — 52 clips\n- Studio / product macro — 21 clips\n",
				"Publishing/youtube-upload-checklist.md":
					"# YouTube Upload Checklist\n\n- [ ] Thumbnail (3 A/B variants)\n- [ ] Chapters + end screen\n- [ ] Captions (.srt)\n- [ ] Pinned comment\n",
				"Ideas/reel-hooks.md":
					"# Reel Hooks\n\n- \"You're editing this the slow way.\"\n- 3 cuts in the first second\n- Pattern interrupt at 0:07\n",
			};
			const folders = new Set(Object.keys(files).map((p) => p.slice(0, p.lastIndexOf("/"))));
			for (const dir of folders) {
				if (!vault.getAbstractFileByPath(dir)) await vault.createFolder(dir).catch(() => undefined);
			}
			for (const [path, content] of Object.entries(files)) {
				if (!vault.getAbstractFileByPath(path)) await vault.create(path, content).catch(() => undefined);
			}
		});

		await browser.executeObsidian(async ({ app }, id) => {
			await (app as unknown as { plugins: { plugins: Record<string, { revealStatusView(): Promise<void> }> } })
				.plugins.plugins[id].revealStatusView(); // ensures a full-mode panel instance exists
		}, PLUGIN_ID);

		// Force Obsidian's DARK base theme so every screenshot is dark. Use the official
		// changeTheme() when present, and set the body theme classes directly as a
		// guarantee (our panel reads --background-*/--color-* which resolve per theme).
		await browser.executeObsidian(async ({ app }) => {
			const a = app as unknown as { changeTheme?: (t: string) => void };
			try {
				a.changeTheme?.("obsidian"); // "obsidian" = dark, "moonstone" = light
			} catch {
				/* fall back to the class toggle below */
			}
			document.body.classList.remove("theme-light");
			document.body.classList.add("theme-dark");
		});
	});

	/**
	 * Mount the live panel into a fixed-width container and wait for its trees, so an
	 * element screenshot renders a deterministic layout at that width.
	 */
	async function mountAt(width: number): Promise<void> {
		await browser.executeObsidian(async ({ app }, id, w) => {
			const a = app as unknown as {
				workspace: { getLeavesOfType(t: string): { view: { panel: unknown } }[] };
			};
			void id;
			const panel = a.workspace.getLeavesOfType("couchdb-sync-status")[0].view.panel as CapturePanel;
			document.querySelectorAll("#cdb-shot").forEach((n) => n.remove());
			const host = document.createElement("div");
			host.id = "cdb-shot";
			host.className = "couchdb-sync-view";
			host.style.cssText =
				`position:fixed;top:0;left:0;z-index:99999;width:${w}px;` +
				`background:var(--background-primary);padding:12px;overflow:auto;max-height:100vh;`;
			document.body.appendChild(host);
			panel.unmount();
			panel.mount(host.createDiv());
		}, PLUGIN_ID, width);
		await browser.waitUntil(
			async () => browser.executeObsidian(() => !!document.querySelector("#cdb-shot .couchdb-sync-tree")),
			{ timeout: 20000, interval: 200, timeoutMsg: "panel did not render" }
		);
		await new Promise((r) => setTimeout(r, 500)); // let store-tree auto-open settle
	}

	async function shoot(file: string): Promise<void> {
		const el = await browser.$("#cdb-shot");
		await el.saveScreenshot(`${OUT}/${file}`);
	}

	it("captures the DESKTOP panel (wide layout)", async function () {
		await mountAt(920);
		await shoot("desktop-panel.png");
	});

	it("captures the MOBILE panel (narrow single-column layout)", async function () {
		await mountAt(420);
		await shoot("mobile-panel.png");
	});
});
