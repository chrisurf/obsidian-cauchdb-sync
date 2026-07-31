import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

/**
 * Lint gate. Beyond the ordinary TypeScript rules this runs the two rule sets the
 * Obsidian plugin review applies — `eslint-plugin-obsidianmd` (platform rules:
 * unsupported APIs, createEl helpers, configDir, command ids) and typescript-
 * eslint's *type-checked* rules, which are what surface unsafe `any` flowing out
 * of untyped PouchDB and Node interop. Both were missing here, so the review kept
 * finding things `npm run lint` could not. Keeping them in the project's own gate
 * is the point: the next review should have nothing left to report.
 */
export default tseslint.config(
	{
		ignores: ["node_modules/", "main.js", "*.mjs", ".e2e-plugin/", "coverage/"],
	},
	...obsidianmd.configs.recommended,
	...tseslint.configs.recommendedTypeChecked,
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"no-unused-vars": "off",
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
			"@typescript-eslint/no-explicit-any": "warn",
			"@typescript-eslint/explicit-module-boundary-types": "off",
			"@typescript-eslint/ban-ts-comment": "off",
			"no-prototype-builtins": "off",
			// Off, not merely unfixed: the rule lowercases anything after the first
			// word, and every hit here is a proper noun, acronym, path or URL that
			// must keep its capitals. Its own suggestions were "Couchdb sync" for the
			// product name, "HTTPS://couch.example.com" for the example server, "aes-
			// 256-gcm", "incl. Protocol" and "e.g. Your desktop". Our UI text is
			// already sentence case; there is nothing left for this rule to find.
			"obsidianmd/ui/sentence-case": "off",
		},
	},
	{
		// The declarative settings API (`getSettingDefinitions`) and `setDestructive`
		// both landed in Obsidian 1.13.0, while this plugin supports 1.7.2 and up —
		// calling them would be a TypeError for everyone in between. Adopting them
		// means raising the floor by six more minor versions purely for settings-
		// search integration, which is not a trade worth making yet. Revisit when
		// 1.13 is old enough to require; the plugin review lists both as advisory.
		files: ["src/settings.ts"],
		rules: {
			"@typescript-eslint/no-deprecated": "off",
			"obsidianmd/settings-tab/prefer-setting-definitions": "off",
		},
	},
	{
		// Tests and e2e specs are not shipped and are not part of the review surface.
		files: ["tests/**/*.ts", "e2e/**/*.ts"],
		...tseslint.configs.disableTypeChecked,
	}
);
