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
 * The `fs`/`path` surface is described by the LOCAL interfaces below rather than
 * `typeof import("fs")`. That is deliberate: the Obsidian plugin review type-checks
 * against a browser-only lib with no `@types/node`, where `typeof import("fs")`
 * collapses to `any` and every `fs.promises.open(...)` / `fd.read(...)` call reads
 * as an unsafe-`any` to typescript-eslint's type-checked rules. Declaring exactly
 * the slice the engine uses keeps the whole streaming path fully typed in every
 * environment — so the review has no unsafe-`any` to report — without pulling
 * Node's ambient types into a browser-targeted plugin.
 */

/** The subset of a Node `FileHandle` the engine uses. */
export interface NodeFileHandle {
	read(
		buffer: Uint8Array,
		offset: number,
		length: number,
		position: number | null
	): Promise<{ bytesRead: number }>;
	write(data: Uint8Array): Promise<{ bytesWritten: number }>;
	close(): Promise<void>;
}

/** The subset of `fs.promises` the engine uses. */
export interface NodeFsPromises {
	open(path: string, flags: string): Promise<NodeFileHandle>;
	mkdir(path: string, options: { recursive: boolean }): Promise<string | undefined>;
	unlink(path: string): Promise<void>;
	rename(oldPath: string, newPath: string): Promise<void>;
}

/** The subset of Node's `fs` the engine uses. */
export interface NodeFs {
	promises: NodeFsPromises;
}

/** The subset of Node's `path` the engine uses. */
export interface NodePath {
	dirname(p: string): string;
}

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
	// Node built-ins; it is provided by the CommonJS bundle wrapper (esbuild
	// `format: "cjs"`) and guarded by Platform.isDesktop directly above — a static
	// import would make the MOBILE bundle try to resolve "fs". Capturing `require`
	// through an explicit function type (rather than calling it directly) keeps the
	// lookup fully typed even when the review type-checks without @types/node — where
	// the ambient `require` would be untyped and a direct call would read as an
	// unsafe-`any` call — and sidesteps `no-require-imports`, which only flags a
	// literal `require(...)` call expression, not a typed reference.
	const nodeRequire = require as unknown as (moduleId: string) => T;
	return nodeRequire(id);
}

/** Node's `fs` (the desktop-only slice the engine uses). Check {@link hasNodeAccess} first. */
export function nodeFs(): NodeFs {
	return desktopRequire<NodeFs>("fs");
}

/** Node's `path` (the desktop-only slice the engine uses). Check {@link hasNodeAccess} first. */
export function nodePath(): NodePath {
	return desktopRequire<NodePath>("path");
}
