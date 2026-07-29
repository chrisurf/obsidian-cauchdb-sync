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
 * We test the min-supported pair (earliest/earliest, = manifest.minAppVersion)
 * and the latest pair, so both the oldest API we promise and the newest ship
 * are covered. Override locally with e.g. OBSIDIAN_VERSIONS="latest/latest".
 */

const cacheDir = path.resolve(".obsidian-cache");

const defaultVersions = "earliest/earliest latest/latest";
const versions = await parseObsidianVersions(env.OBSIDIAN_VERSIONS ?? defaultVersions, { cacheDir });

if (env.CI) {
	// Printed so CI can derive a cache key from the resolved versions (see e2e.yml).
	console.log("obsidian-cache-key:", JSON.stringify([versions]));
}

export const config: WebdriverIO.Config = {
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
			// The plugin under test: the repo root holds the built main.js + manifest.json.
			plugins: ["."],
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
