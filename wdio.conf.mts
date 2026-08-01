import * as fs from "node:fs";
import * as path from "node:path";
import { env } from "node:process";
import { parseObsidianVersions } from "wdio-obsidian-service";

/**
 * WebdriverIO configuration for end-to-end testing the CouchDB Sync plugin
 * inside a real Obsidian instance (via wdio-obsidian-service).
 *
 * The service downloads Obsidian binaries into `.obsidian-cache`, launches them
 * through Electron/Chromedriver in a sandboxed config dir, installs the built
 * plugin (main.js + manifest.json from the repo root) into the test vault and
 * enables it (restricted mode off). Run `npm run build` first — `test:e2e` does.
 *
 * Obsidian has two independent version axes:
 *   - appVersion       — the Obsidian JS bundle (what auto-update ships)
 *   - installerVersion — the Electron/Chromium base (only replaced on reinstall)
 *
 * We default to the latest stable pair, which obsidian-launcher can download
 * from the public releases without credentials. `earliest/earliest` resolves to
 * this plugin's manifest.minAppVersion (1.7.2, a stable release), so widening the
 * matrix is a matter of setting the env var:
 *   OBSIDIAN_VERSIONS="earliest/earliest latest/latest"
 * (The floor used to be 1.4.0, which obsidian-versions.json flags as a BETA build
 * and which therefore needed Insiders credentials to download — no longer the
 * case, but CI still runs one version by default to keep the job short.)
 */

const cacheDir = path.resolve(".obsidian-cache");

/**
 * Stage a CLEAN copy of the plugin for the sandbox vault.
 *
 * The service copies the whole plugin directory it is pointed at. Pointing it at
 * the repo root would drag a developer's local `data.json` — real server URL,
 * password and E2EE passphrase — into every run: the privacy-gate spec then sees
 * an already-configured, already-verified plugin and fails, and a spec that runs
 * "Sync now" would replicate the fixture vault into a REAL database. `data.json`
 * is gitignored, so this only ever bites locally, never in CI — the worst kind of
 * flake. Copy just the three release artifacts instead.
 *
 * The actual staging (wipe + copy) is done ONCE in onPrepare, not here at module
 * load. This config module is re-imported by every worker process, so doing the
 * `rmSync` here made two parallel workers race: one wiped `.e2e-plugin` while the
 * other was mid-`installPlugins`, which failed with "main.js missing". onPrepare
 * runs only in the launcher, before any worker session starts.
 */
const pluginDir = path.resolve(".e2e-plugin");
const artifacts = ["manifest.json", "main.js", "styles.css"];

function stagePlugin(): void {
	const missing = artifacts.filter((f) => !fs.existsSync(path.resolve(f)));
	if (missing.length > 0) {
		throw new Error(`Missing build artifact(s): ${missing.join(", ")}. Run "npm run build" first.`);
	}
	fs.rmSync(pluginDir, { recursive: true, force: true });
	fs.mkdirSync(pluginDir, { recursive: true });
	for (const f of artifacts) fs.copyFileSync(path.resolve(f), path.join(pluginDir, f));
}

const defaultVersions = "latest/latest";
const versions = await parseObsidianVersions(env.OBSIDIAN_VERSIONS ?? defaultVersions, { cacheDir });

if (env.CI) {
	// Printed so CI can derive a cache key from the resolved versions (see e2e.yml).
	console.log("obsidian-cache-key:", JSON.stringify([versions]));
}

export const config: WebdriverIO.Config = {
	// Stage the plugin once, in the launcher, before workers spawn — never per worker
	// at module load (that raced two workers over the same .e2e-plugin directory).
	onPrepare() {
		stagePlugin();
	},

	runner: "local",
	framework: "mocha",

	specs: ["./e2e/specs/**/*.e2e.ts"],

	// GitHub runners are 2-core; keep parallelism modest. Override with WDIO_MAX_INSTANCES.
	maxInstances: Number(env.WDIO_MAX_INSTANCES || 2),

	capabilities: versions.map(([appVersion, installerVersion]) => ({
		browserName: "obsidian",
		"wdio:obsidianOptions": {
			appVersion,
			installerVersion,
			// The plugin under test: a clean staging copy, never the repo root (see above).
			plugins: [pluginDir],
			// Starting vault fixture; specs reset it per-test via obsidianPage.resetVault().
			vault: "e2e/vaults/simple",
		},
	})),

	services: ["obsidian"],
	// Reports the Obsidian version (not the Chromium version) in the spec output.
	reporters: ["obsidian"],

	mochaOpts: {
		ui: "bdd",
		// Obsidian boot is slow; give each test room. Sync/network specs need it.
		timeout: 60 * 1000,
	},

	waitforInterval: 250,
	waitforTimeout: 10 * 1000,
	logLevel: "warn",
	cacheDir,

	// Import describe/it/expect explicitly in specs rather than relying on globals.
	injectGlobals: false,
};
