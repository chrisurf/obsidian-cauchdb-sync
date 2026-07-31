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

/** All registered command ids (e.g. "couchdb-sync:force-sync"). */
export function commandIds(): Promise<string[]> {
	return browser.executeObsidian(({ app }) => {
		const commands = (app as unknown as { commands: { commands: Record<string, unknown> } }).commands;
		return Object.keys(commands.commands);
	});
}

/** A snapshot of what the plugin's settings tab actually renders. */
export interface SettingsSnapshot {
	headings: string[];
	settingNames: string[];
	/** true if the per-file sync tree is rendered (only after a verified connection) */
	hasTree: boolean;
	text: string;
}

/**
 * Render the plugin's settings tab and read back its content.
 *
 * We drive the real tab object (`openTab(tab)` + `display()`) and read its
 * `containerEl` directly, rather than asserting on the settings-modal DOM via
 * WDIO selectors. On Obsidian 1.13.x `app.setting.open()` does not build the
 * modal DOM in the headless test runner, but the setting tab's own
 * `containerEl` is connected to the document and holds the rendered UI — so
 * this reads exactly what the plugin renders, on every Obsidian version.
 */
export function renderSettingsSnapshot(): Promise<SettingsSnapshot> {
	return browser.executeObsidian(({ app }, id) => {
		const a = app as unknown as {
			setting: {
				open?(): void;
				openTab?(tab: unknown): void;
				pluginTabs?: { id: string; containerEl: HTMLElement; display(): void }[];
				settingTabs?: { id: string; containerEl: HTMLElement; display(): void }[];
			};
		};
		const tabs = [...(a.setting.pluginTabs ?? []), ...(a.setting.settingTabs ?? [])];
		const tab = tabs.find((t) => t.id === id);
		if (!tab) throw new Error(`settings tab '${id}' not found`);
		a.setting.open?.();
		a.setting.openTab?.(tab);
		// Section headings are Setting(...).setHeading() rows, which Obsidian renders
		// as .setting-item.setting-item-heading — NOT as <h2>. Reading h2 here is what
		// the plugin review asked us to stop emitting, so the probe follows the markup.
		const HEADING_SEL = ".setting-item-heading .setting-item-name";
		// Ensure a render even if opening the modal was a no-op headless.
		if (!tab.containerEl || tab.containerEl.querySelectorAll(HEADING_SEL).length === 0) {
			tab.display();
		}
		const ce = tab.containerEl;
		return {
			headings: Array.from(ce.querySelectorAll(HEADING_SEL)).map((h) => h.textContent ?? ""),
			settingNames: Array.from(
				ce.querySelectorAll(".setting-item:not(.setting-item-heading) .setting-item-name")
			).map((e) => e.textContent ?? ""),
			hasTree: !!ce.querySelector(".couchdb-sync-tree"),
			text: ce.textContent ?? "",
		};
	}, PLUGIN_ID);
}

/** Close the settings modal (harmless if it was never actually shown). */
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
