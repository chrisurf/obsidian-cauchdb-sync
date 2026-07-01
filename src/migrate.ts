import { CouchDBSyncSettings, DEFAULT_HIDDEN_EXCLUDE } from "./types";

/**
 * Pure, idempotent settings migration. Mutates the given (already default-merged)
 * settings object in place and returns whether anything changed. The caller gates
 * this by schema version, so it runs once per bump and never clobbers a user's
 * later deliberate edits. Kept free of the Obsidian API so it is unit-testable.
 *
 * v1: (a) re-union the safe default hidden-exclude baseline (`.git/`, `.obsidian/`,
 * …) so a config that predates a given entry stops syncing a whole git repo / the
 * entire .obsidian folder; (b) strip the dead `excludePatterns` / `ignorePatterns`
 * keys left over from the pre-hidden ignore model.
 */
export function migrateSettings(
	settings: CouchDBSyncSettings & Record<string, unknown>,
	priorVersion: number
): boolean {
	let changed = false;

	if (priorVersion < 1) {
		// (a) union the default excludes into whatever the user already has
		const have = new Set(settings.hiddenExclude ?? []);
		const before = have.size;
		for (const p of DEFAULT_HIDDEN_EXCLUDE) have.add(p);
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

	return changed;
}
