import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments';

export default defineConfig([
	...obsidianmd.configs.recommended,
	{
		// TypeScript plugin source files
		files: ['*.ts'],
		extends: [...tseslint.configs.recommended],
		plugins: { '@eslint-community/eslint-comments': eslintComments },
		linterOptions: { reportUnusedDisableDirectives: 'error' },
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: { project: './tsconfig.json' },
		},
		rules: {
			'obsidianmd/ui/sentence-case': ['error', { brands: ['Flint', 'Firebase', 'Obsidian'], acronyms: ['SDK', 'CRDT', 'ID'], enforceCamelCaseLower: true }],
			'@typescript-eslint/no-unused-vars': ['error', { args: 'none' }],
			'@typescript-eslint/ban-ts-comment': 'off',
			'@typescript-eslint/no-empty-function': 'off',
			'@typescript-eslint/no-redundant-type-constituents': 'error',
			'@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],
			'@typescript-eslint/no-unnecessary-type-assertion': 'error',
			'depend/ban-dependencies': 'off',
			'@eslint-community/eslint-comments/require-description': ['error', { ignore: ['eslint-enable'] }],
			'@eslint-community/eslint-comments/disable-enable-pair': 'error',
			'@eslint-community/eslint-comments/no-unused-disable': 'error',
		},
	},
	{
		// Test and mock files — relax strict typing rules
		files: ['__tests__/**/*.ts', '__mocks__/**/*.ts'],
		extends: [...tseslint.configs.recommended],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: { project: './tsconfig.json' },
		},
		rules: {
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-unsafe-assignment': 'off',
			'@typescript-eslint/no-unsafe-call': 'off',
			'@typescript-eslint/no-unsafe-member-access': 'off',
			'@typescript-eslint/no-unsafe-argument': 'off',
			'@typescript-eslint/no-unsafe-return': 'off',
			'@typescript-eslint/no-unused-vars': ['error', { args: 'none' }],
			'obsidianmd/hardcoded-config-path': 'off',
			'depend/ban-dependencies': 'off',
		},
	},
	{
		// Node.js utility scripts
		files: ['deploy.mjs', 'version-bump.mjs', 'release.mjs'],
		languageOptions: {
			globals: { process: 'readonly', console: 'readonly' },
		},
		rules: { 'no-undef': 'off', 'depend/ban-dependencies': 'off' },
	},
	{
		// Vitest config — needs Node.js path module
		files: ['vitest.config.ts'],
		rules: { 'import/no-nodejs-modules': 'off', 'depend/ban-dependencies': 'off' },
	},
	{
		ignores: ['node_modules/', 'dist/', 'main.js', 'functions/'],
	},
]);
