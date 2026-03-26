/**
 * Release script — bumps version, builds, commits, tags, pushes, and creates
 * a GitHub release with the required assets.
 *
 * Usage:
 *   node release.mjs          # patch bump (1.0.x → 1.0.x+1)
 *   node release.mjs minor    # minor bump
 *   node release.mjs major    # major bump
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';

const bump = process.argv[2] ?? 'patch';
if (!['patch', 'minor', 'major'].includes(bump)) {
	console.error(`Unknown bump type "${bump}". Use patch, minor, or major.`);
	process.exit(1);
}

function run(cmd, opts = {}) {
	console.log(`> ${cmd}`);
	return execSync(cmd, { stdio: 'inherit', cwd: new URL('.', import.meta.url).pathname, ...opts });
}

// 1. Ensure working tree is clean
try {
	execSync('git diff --quiet && git diff --cached --quiet', { stdio: 'pipe' });
} catch {
	console.error('Working tree is not clean. Commit or stash changes first.');
	process.exit(1);
}

// 2. npm version — updates package.json AND triggers the "version" lifecycle
//    hook (version-bump.mjs) which writes manifest.json, ../manifest.json,
//    and versions.json with the correct version string.
run(`npm version ${bump} --no-git-tag-version`);

// 3. Read the new version from package.json (source of truth)
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
console.log(`\nReleasing v${version}\n`);

// 4. Build production bundle
run('npm run build');

// 5. Commit version files (manifest.json, versions.json already staged by
//    the "version" hook; add package files and root manifest manually)
run('git add package.json package-lock.json ../manifest.json');
run(`git commit -m "Bump version to ${version}"`);

// 6. Tag and push
run(`git tag ${version}`);
run('git push --set-upstream origin main');
run(`git push origin ${version}`);

// 7. Create GitHub release with required Obsidian assets
run(`gh release create ${version} dist/main.js manifest.json styles.css --title "${version}" --notes "Release ${version}"`);

console.log(`\nDone! https://github.com/tiagofabre/Flint/releases/tag/${version}`);
