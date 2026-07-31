import { CouchDBSyncSettings, defaultHiddenExclude } from "./types";

/**
 * Pure, idempotent settings migration. Mutates the given (already default-merged)
 * settings object in place and returns whether anything changed. The caller gates
 * this by schema version, so it runs once per bump and never clobbers a user's
 * later deliberate edits. Kept free of the Obsidian API so it is unit-testable.
 *
 * v1: (a) re-union the safe default hidden-exclude baseline (`.git/`, the vault's
 * configuration folder, …) so a config that predates a given entry stops syncing a
 * whole git repo / the entire settings folder; (b) strip the dead `excludePatterns`
 * / `ignorePatterns` keys left over from the pre-hidden ignore model.
 *
 * v2: fold the removed `autoStart` flag into `syncEnabled`. The two meant almost
 * the same thing, which is how a config could claim "sync is on" while nothing ever
 * ran. A config that had auto-start OFF keeps that intent — sync is switched off,
 * visibly, rather than silently starting to replicate after an update. Everything
 * else is untouched, so the common case (auto-start on) simply keeps syncing.
 */
export function migrateSettings(
	settings: CouchDBSyncSettings & Record<string, unknown>,
	priorVersion: number,
	configDir: string
): boolean {
	let changed = false;

	if (priorVersion < 1) {
		// (a) union the default excludes into whatever the user already has
		const have = new Set(settings.hiddenExclude ?? []);
		const before = have.size;
		for (const p of defaultHiddenExclude(configDir)) have.add(p);
		if (have.size !== before) {
			settings.hiddenExclude = [...have];
			changed = true;
		}

		// (b) drop dead keys from the pre-hidden ignore model
		for (const deadKey of ["excludePatterns", "ignorePatterns"]) {
			if (deadKey in settings) {
				delete settings[deadKey];
				changed = true;
			}
		}
	}

	if (priorVersion < 2) {
		// Never start replicating on this vault's behalf just because an update
		// removed a flag: an explicit "do not start on launch" becomes an explicit
		// "sync is off", which the status card states plainly and the user can undo
		// with one click.
		if (settings.autoStart === false) {
			settings.syncEnabled = false;
			changed = true;
		}
		if ("autoStart" in settings) {
			delete settings.autoStart;
			changed = true;
		}
	}

	return changed;
}
