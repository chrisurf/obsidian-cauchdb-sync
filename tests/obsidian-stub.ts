// Minimal runtime stub for the "obsidian" module. The real package ships only
// type declarations (obsidian.d.ts), so any test that imports a src module which
// imports from "obsidian" needs a runtime shim. Only symbols actually reached at
// runtime by the code under test need real behaviour; the rest are placeholders.

export async function requestUrl(): Promise<never> {
	throw new Error("obsidian.requestUrl is not available in unit tests");
}

// Placeholder classes/values so `instanceof` checks and imports resolve if reached.
export class TFile {}
export class TFolder {}
export class FileSystemAdapter {}
export const Platform = { isDesktop: false, isMobile: true };
export function normalizePath(p: string): string {
	return p;
}
export function debounce<T extends (...args: never[]) => unknown>(fn: T): T {
	// The real obsidian.debounce returns a callable carrying `cancel()` and `run()`.
	// Tests need those to exist (e.g. engine.stop() cancels its debouncers); the timing
	// is elided — calls run synchronously — which keeps unit tests deterministic.
	const wrapped = ((...args: Parameters<T>) => fn(...args)) as T & {
		cancel(): void;
		run(): void;
	};
	wrapped.cancel = () => undefined;
	wrapped.run = () => undefined;
	return wrapped;
}
