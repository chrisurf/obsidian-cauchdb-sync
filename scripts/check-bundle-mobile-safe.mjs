// Guard against the "installs but won't enable on mobile" class of bug.
//
// Obsidian mobile has no Node `require`, so a top-level `require("<builtin>")` left
// in the bundle throws while the plugin module is still being evaluated — the
// plugin can be installed but never enabled. That is exactly what a bundled
// PouchDB `require("events")` did until esbuild was told to polyfill it instead of
// externalizing it. This check fails the build if main.js contains a runtime
// `require(...)` of any Node built-in. `require("obsidian")` / `require("electron")`
// are fine: Obsidian provides those on every platform, desktop and mobile alike.
//
// Run after `npm run build` (see the CI workflow). Exit non-zero on a finding.

import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";

const BUNDLE = "main.js";
const ALLOWED = new Set(["obsidian", "electron"]);

let code;
try {
	code = readFileSync(new URL(`../${BUNDLE}`, import.meta.url), "utf8");
} catch {
	console.error(`check-bundle-mobile-safe: ${BUNDLE} not found — run \`npm run build\` first.`);
	process.exit(2);
}

const builtins = new Set([
	...builtinModules,
	...builtinModules.map((m) => `node:${m}`),
]);

// Match string-literal require() calls: require("x") / require('x').
const re = /require\(\s*["']([^"']+)["']\s*\)/g;
const offenders = new Set();
for (const m of code.matchAll(re)) {
	const id = m[1];
	if (ALLOWED.has(id)) continue;
	if (builtins.has(id)) offenders.add(id);
}

if (offenders.size > 0) {
	console.error(
		`check-bundle-mobile-safe: ${BUNDLE} contains runtime require() of Node built-in(s): ` +
			`${[...offenders].map((s) => `"${s}"`).join(", ")}.\n` +
			"These throw on Obsidian mobile (no Node require) and stop the plugin from being enabled.\n" +
			"Polyfill the module instead of externalizing it in esbuild.config.mjs (see BROWSER_POLYFILLED)."
	);
	process.exit(1);
}

console.log(`check-bundle-mobile-safe: ${BUNDLE} has no Node built-in require() — mobile-safe ✓`);
