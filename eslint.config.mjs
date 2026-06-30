import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parser: tsparser,
			parserOptions: {
				ecmaVersion: 2020,
				sourceType: "module",
			},
		},
		plugins: {
			"@typescript-eslint": tseslint,
		},
		rules: {
			...tseslint.configs.recommended.rules,
			"no-unused-vars": "off",
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
			"@typescript-eslint/no-explicit-any": "warn",
			"@typescript-eslint/explicit-module-boundary-types": "off",
			"@typescript-eslint/ban-ts-comment": "off",
			"@typescript-eslint/no-require-imports": "off",
			"no-prototype-builtins": "off",
		},
	},
	{
		ignores: ["node_modules/", "main.js", "*.mjs"],
	},
];
