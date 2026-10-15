#!/usr/bin/env node
// Builds dist/extension-<version>.zip for the Chrome Web Store / Edge Add-ons (manifest.json at the zip root).
// Excludes tests, dotfiles and store/ (listing sources). Needs the `zip` CLI.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extDir = join(root, 'extension');
const { version } = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
const out = join(root, 'dist', `extension-${version}.zip`);

mkdirSync(dirname(out), { recursive: true });
rmSync(out, { force: true });
execFileSync('zip', ['-r', '-X', '-q', out, '.', '-x', '*.test.js', '.*', '*/.*', 'store/*'], {
  cwd: extDir,
  stdio: 'inherit',
});
console.error(`Packed ${out}`);
