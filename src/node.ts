import { Platform } from "obsidian";

/**
 * Desktop-only access to Node's `fs` and `path`.
 *
 * The engine streams large files to and from disk, which needs real file
 * descriptors — an Obsidian adapter read would materialize a 600 MB file in
 * memory. Those APIs exist only in Obsidian's desktop (Electron) runtime, so
 * every call site is behind `Platform.isDesktop` and has a mobile fallback that
 * goes through the vault adapter instead.
 *
 * Both modules are reached through this one file for two reasons. The guard sits
 * next to the lookup, so it cannot drift away from it as call sites move; and
 * `require` returns `any`, which used to spread untyped values through the
 * engine's streaming paths. Declaring the return type here contains that to a
 * single line and gives every caller the real `fs`/`path` types.
 */

/**
 * `true` when Node's built-ins can be reached at all. Call this before the
 * accessors below; they throw rather than return null, because reaching them on
 * mobile means a missing branch, not a condition to handle at runtime.
 */
export function hasNodeAccess(): boolean {
	return Platform.isDesktop;
}

function desktopRequire<T>(id: string): T {
	if (!Platform.isDesktop) {
		throw new Error(`Node module "${id}" is not available on this platform`);
	}
	// Electron's synchronous require is the documented way for a plugin to reach
	// Node built-ins, and it is guarded by Platform.isDesktop directly above. A
	// static import would break the mobile bundle, which must not resolve "fs".
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- guarded by Platform.isDesktop directly above; a static import would make the mobile bundle resolve "fs"
	return require(id) as T;
}

/** Node's `fs`. Desktop only — check {@link hasNodeAccess} first. */
export function nodeFs(): typeof import("fs") {
	return desktopRequire<typeof import("fs")>("fs");
}

/** Node's `path`. Desktop only — check {@link hasNodeAccess} first. */
export function nodePath(): typeof import("path") {
	return desktopRequire<typeof import("path")>("path");
}
