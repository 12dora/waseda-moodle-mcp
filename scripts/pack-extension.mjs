#!/usr/bin/env node
// Builds dist/extension-<version>.zip for the Chrome Web Store / Edge Add-ons (manifest.json at the zip root).
// Excludes tests, dotfiles and store/ (listing sources). Needs the `zip` CLI.
// `--out <path>` writes the zip there instead (the deploy puts it at web/dist/extension.zip: the connect page offers
// it for a manual install while no store listing is configured).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extDir = join(root, 'extension');
const { version } = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
const outArg = process.argv.indexOf('--out');
const out = outArg > 0 ? resolve(root, process.argv[outArg + 1]) : join(root, 'dist', `extension-${version}.zip`);

mkdirSync(dirname(out), { recursive: true });
rmSync(out, { force: true });
execFileSync('zip', ['-r', '-X', '-q', out, '.', '-x', '*.test.js', '.*', '*/.*', 'store/*'], {
  cwd: extDir,
  stdio: 'inherit',
});
console.error(`Packed ${out}`);
