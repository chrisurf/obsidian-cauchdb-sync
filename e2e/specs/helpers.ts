import { browser } from "@wdio/globals";

/** The plugin id from manifest.json. */
export const PLUGIN_ID = "couchdb-sync";

/**
 * Node-side wrappers around `browser.executeObsidian(...)`. Each callback is
 * serialized and executed inside Obsidian's renderer, so it may NOT close over
 * outer variables — everything it needs is passed as an explicit argument.
 * `app.plugins` / `app.commands` / `app.setting` are Obsidian internals not in
 * the public typings, hence the local `any` casts.
 */

/** True when the plugin is both loaded and enabled. */
export function pluginIsEnabled(): Promise<boolean> {
	return browser.executeObsidian(({ app }, id) => {
		const plugins = (app as unknown as { plugins: { enabledPlugins: Set<string>; plugins: Record<string, unknown> } }).plugins;
		return plugins.enabledPlugins.has(id) && !!plugins.plugins[id];
	}, PLUGIN_ID);
}

/** All registered command ids (e.g. "couchdb-sync:couchdb-sync-now"). */
export function commandIds(): Promise<string[]> {
	return browser.executeObsidian(({ app }) => {
		const commands = (app as unknown as { commands: { commands: Record<string, unknown> } }).commands;
		return Object.keys(commands.commands);
	});
}

/** Open the plugin's settings tab (settings modal + our tab selected). */
export async function openPluginSettings(): Promise<void> {
	await browser.executeObsidian(({ app }, id) => {
		const setting = (app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
		setting.open();
		setting.openTabById(id);
	}, PLUGIN_ID);
}

/** Close any open settings modal. */
export async function closeSettings(): Promise<void> {
	await browser.executeObsidian(({ app }) => {
		(app as unknown as { setting: { close(): void } }).setting.close();
	});
}

/**
 * Call a zero-arg public method on the plugin instance and return its (awaited)
 * result. Used to read plugin state (getIndexReport, getOriginState, ...) or
 * trigger safe actions (wipeLocalOnly, ...) from a test.
 */
export function callPlugin<T = unknown>(method: string): Promise<T> {
	return browser.executeObsidian(
		async ({ app }, id, m) => {
			const plugin = (app as unknown as { plugins: { plugins: Record<string, Record<string, unknown>> } }).plugins.plugins[id];
			const fn = plugin[m] as (...a: unknown[]) => unknown;
			return await fn.call(plugin);
		},
		PLUGIN_ID,
		method,
	) as Promise<T>;
}

/** Read the plugin's persisted settings (data.json contents in memory). */
export function pluginSettings<T = Record<string, unknown>>(): Promise<T> {
	return browser.executeObsidian(({ app }, id) => {
		const plugin = (app as unknown as { plugins: { plugins: Record<string, { settings: unknown }> } }).plugins.plugins[id];
		return plugin.settings as T;
	}, PLUGIN_ID);
}
