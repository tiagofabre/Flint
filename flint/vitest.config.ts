import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
	test: {
		environment: 'node',
		globals: true,
	},
	resolve: {
		alias: {
			'obsidian': resolve(__dirname, '__mocks__/obsidian.ts'),
			'main': resolve(__dirname, 'main.ts'),
			'firebase-tools': resolve(__dirname, 'firebase-tools.ts'),
			'flint-settings': resolve(__dirname, 'flint-settings.ts'),
			'crdt': resolve(__dirname, 'crdt.ts'),
			'datatools': resolve(__dirname, 'datatools.ts'),
		},
	},
});
