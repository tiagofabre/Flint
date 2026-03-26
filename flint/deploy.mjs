import { cpSync, existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

// Load .env if present (key=value format, no need for dotenv dependency)
if (existsSync('.env')) {
	for (const line of readFileSync('.env', 'utf8').split('\n')) {
		const [key, ...rest] = line.split('=');
		if (key && rest.length && !process.env[key.trim()]) {
			process.env[key.trim()] = rest.join('=').trim();
		}
	}
}

const dest = process.env.OBSIDIAN_PLUGIN_DIR;
if (!dest) {
	console.error(
		'Error: OBSIDIAN_PLUGIN_DIR is not set.\n' +
		'Copy .env.example to .env and set the path to your Obsidian plugin directory.'
	);
	process.exit(1);
}

const target = resolve(dest);
if (!existsSync(target)) {
	console.error(`Error: target directory does not exist: ${target}`);
	process.exit(1);
}

const files = [
	['dist/main.js', 'main.js'],
	['manifest.json', 'manifest.json'],
	['styles.css', 'styles.css'],
];

for (const [src, out] of files) {
	cpSync(src, `${target}/${out}`);
	console.log(`  copied ${src} → ${target}/${out}`);
}
console.log('Deploy complete.');
