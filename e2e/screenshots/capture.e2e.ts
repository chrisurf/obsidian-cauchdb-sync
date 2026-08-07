import { browser } from "@wdio/globals";
import { describe, it, before } from "mocha";
import { PLUGIN_ID } from "../specs/helpers.js";

/**
 * PROTOTYPE screenshot capture — proof that the existing E2E harness
 * (wdio-obsidian-service driving a REAL Obsidian) can produce documentation
 * screenshots of the actual plugin, on demand, deterministically.
 *
 * It lives OUTSIDE e2e/specs/** on purpose, so it never runs in the normal test
 * suite. It expects a CouchDB-compatible server on http://127.0.0.1:5984 with a
 * "demo-vault" database and a user matching the credentials below, so the plugin
 * performs a REAL sync and the panel shows the green "in sync" state with SYNC ON.
 *
 * A throwaway server is enough. With pouchdb-server (in "admin party") you must
 * create an admin that matches the credentials, otherwise sending any Basic-auth
 * header for an unknown user returns 401:
 *
 *   npx pouchdb-server --host 127.0.0.1 --port 5984 --in-memory &
 *   curl -X PUT  http://127.0.0.1:5984/_config/admins/editor -d '"editor"'
 *   curl -u editor:editor -X PUT http://127.0.0.1:5984/demo-vault
 *
 * Then run the capture:
 *   OBSIDIAN_VERSIONS="latest/latest" WDIO_MAX_INSTANCES=1 \
 *     npx wdio run ./wdio.conf.mts --spec ./e2e/screenshots/capture.e2e.ts
 *
 * Output PNGs land in assets/ (panel-desktop.png, panel-mobile.png).
 *
 * Note: Obsidian's Electron chromedriver can't resize the window
 * (Browser.getWindowForTarget), so instead of resizing we mount the plugin's own
 * panel into a fixed-width container and take an ELEMENT screenshot — 420px is the
 * mobile single-column layout, ~920px the desktop layout. Same code, no device.
 */
const OUT = "assets";
const SERVER = "http://127.0.0.1:5984";
const DB = "demo-vault";

type CapturePanel = { mount(root: HTMLElement): void; unmount(): void };

describe("CouchDB Sync — documentation screenshots (prototype)", function () {
	before(async function () {
		// 1) Point the plugin at the local demo server and turn sync ON.
		await browser.executeObsidian(async ({ app }, id, server, db) => {
			const plugin = (
				app as unknown as { plugins: { plugins: Record<string, {
					settings: Record<string, unknown>; saveSettings(): Promise<void>;
				}> } }
			).plugins.plugins[id];
			plugin.settings.serverUrl = server;
			plugin.settings.dbName = db;
			plugin.settings.username = "editor";
			plugin.settings.password = "editor";
			plugin.settings.e2eeEnabled = false;
			plugin.settings.syncEnabled = true; // SYNC ON
			plugin.settings.liveSync = true;
			plugin.settings.connectionVerified = true;
			await plugin.saveSettings();
		}, PLUGIN_ID, SERVER, DB);

		// 2) Seed a realistic CREATIVE VIDEO-EDITING vault (runtime only; the committed
		//    fixture is untouched). Remove the default fixture entries first so the
		//    screenshots show ONLY this vault.
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
			for (const child of [...vault.getRoot().children]) {
				if (!child.name.startsWith(".")) await vault.delete(child, true).catch(() => undefined);
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
					"# Resolve Shortcuts\n\n- Blade: `B` · Ripple delete: `Shift+Del`\n- Retime: `R` · Dynamic zoom: `Alt+Z`\n",
				"Editing/color-grading-notes.md":
					"# Color Notes\n\n- Base: Rec.709 @ 2.4 gamma\n- Skin: keep in the vector line\n- Halation on speculars (subtle)\n",
				"Assets/music-licenses.md":
					"# Music Licenses\n\n| Track | Source | License |\n|---|---|---|\n| Neon Drive | Artlist | commercial |\n| Slow Tide | Musicbed | per-project |\n",
				"Assets/broll-inventory.md":
					"# B-Roll Inventory\n\n- City / night / neon — 37 clips\n- Nature / water — 52 clips\n- Studio / product macro — 21 clips\n",
				"Publishing/youtube-upload-checklist.md":
					"# YouTube Upload Checklist\n\n- [ ] Thumbnail (3 A/B variants)\n- [ ] Chapters + end screen\n- [ ] Captions (.srt)\n",
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

		// 3) Force Obsidian's DARK base theme so every screenshot is dark.
		await browser.executeObsidian(async ({ app }) => {
			const a = app as unknown as { changeTheme?: (t: string) => void };
			try { a.changeTheme?.("obsidian"); } catch { /* class toggle below */ }
			document.body.classList.remove("theme-light");
			document.body.classList.add("theme-dark");
		});

		// 4) Run a real sync pass (uploads the vault to the demo server).
		await browser.executeObsidian(async ({ app }, id) => {
			await (app as unknown as { plugins: { plugins: Record<string, { restartSync(): Promise<void> }> } })
				.plugins.plugins[id].restartSync();
		}, PLUGIN_ID);

		// 5) Wait until the server actually holds the file docs (polled from Node, which
		//    sidesteps the plugin's throttled remote-scan cache).
		await browser.waitUntil(async () => {
			try {
				const res = await fetch(
					`${SERVER}/${DB}/_all_docs?startkey=%22f%3A%22&endkey=%22f%3A%EF%BF%BF%22`
				);
				if (!res.ok) return false;
				const j = (await res.json()) as { rows?: unknown[] };
				return (j.rows?.length ?? 0) >= 11;
			} catch {
				return false;
			}
		}, { timeout: 60000, interval: 500, timeoutMsg: "server never received the file docs" });

		// 6) Wait until the plugin's own report agrees: disk = cache = server, all synced.
		await browser.waitUntil(
			async () =>
				browser.executeObsidian(async ({ app }, id) => {
					const p = (app as unknown as { plugins: { plugins: Record<string, {
						getIndexReport(): Promise<{
							vaultCount: number; dbCount: number; serverCount?: number;
							serverReachable?: boolean; inSync: string[];
						} | null> }> } }).plugins.plugins[id];
					const r = await p.getIndexReport();
					return !!r && r.serverReachable === true && r.serverCount === r.vaultCount &&
						r.dbCount === r.vaultCount && r.inSync.length === r.vaultCount && r.vaultCount > 0;
				}, PLUGIN_ID),
			{ timeout: 60000, interval: 1000, timeoutMsg: "panel never reached the fully-synced state" }
		);

		// 7) Make sure a full-mode panel instance exists to mount for screenshots.
		await browser.executeObsidian(async ({ app }, id) => {
			await (app as unknown as { plugins: { plugins: Record<string, { revealStatusView(): Promise<void> }> } })
				.plugins.plugins[id].revealStatusView();
		}, PLUGIN_ID);
	});

	async function mountAt(width: number): Promise<void> {
		await browser.executeObsidian(async ({ app }, id, w) => {
			void id;
			const a = app as unknown as {
				workspace: { getLeavesOfType(t: string): { view: { panel: unknown } }[] };
			};
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
		// Expand the Disk (Vault) tree so the (video-editing) files are visible in the
		// shot — in the all-green state the store trees collapse by default.
		await browser.executeObsidian(() => {
			const d = document.querySelector(
				'#cdb-shot details[data-section-id="store-disk"]'
			) as HTMLDetailsElement | null;
			if (d) d.open = true;
		});
		await new Promise((r) => setTimeout(r, 500));
	}

	async function shoot(file: string): Promise<void> {
		const el = await browser.$("#cdb-shot");
		await el.saveScreenshot(`${OUT}/${file}`);
	}

	it("captures the DESKTOP panel (wide layout, synced)", async function () {
		await mountAt(920);
		await shoot("panel-desktop.png");
	});

	it("captures the MOBILE panel (narrow layout, synced)", async function () {
		await mountAt(420);
		await shoot("panel-mobile.png");
	});
});
