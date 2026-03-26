import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default tseslint.config(
	...obsidianmd.configs.recommended,
	{
		// TypeScript plugin source files
		files: ['*.ts'],
		extends: [...tseslint.configs.recommended],
		languageOptions: {
			parserOptions: { project: './tsconfig.json' },
		},
		rules: {
			'@typescript-eslint/no-unused-vars': ['error', { args: 'none' }],
			'@typescript-eslint/ban-ts-comment': 'off',
			'@typescript-eslint/no-empty-function': 'off',
			'depend/ban-dependencies': 'off',
			'obsidianmd/ui/sentence-case': ['error', { ignoreWords: ['Flint'] }],
		},
	},
	{
		// Test and mock files — relax strict typing rules
		files: ['__tests__/**/*.ts', '__mocks__/**/*.ts'],
		extends: [...tseslint.configs.recommended],
		languageOptions: {
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
	}
);
