#!/usr/bin/env node
// Builds dist/extension-<version>.zip for the Chrome Web Store / Edge Add-ons (manifest.json at the zip root).
// Excludes tests, dotfiles and store/ (listing sources). Needs the `zip` CLI.
// `EXTENSION_SERVICE_URL=https://…` fills in the settings page's default service URL (lib/defaults.js) and declares it
// as a host permission, in the package only; the source keeps both empty.
// `--out <path>` writes the zip there instead (the deploy puts it at web/dist/extension.zip: the connect page offers
// it for a manual install while no store listing is configured).
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extDir = join(root, 'extension');
const { version } = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
const outArg = process.argv.indexOf('--out');
const out = outArg > 0 ? resolve(root, process.argv[outArg + 1]) : join(root, 'dist', `extension-${version}.zip`);

/** The https origin of EXTENSION_SERVICE_URL, '' when unset; anything else is an error. */
function serviceOrigin() {
  const raw = (process.env.EXTENSION_SERVICE_URL ?? '').trim();
  if (!raw) return '';
  const u = new URL(raw);
  if (u.protocol !== 'https:') throw new Error('EXTENSION_SERVICE_URL must be an https URL.');
  return u.origin;
}

const staging = mkdtempSync(join(tmpdir(), 'wmm-ext-'));
try {
  cpSync(extDir, staging, { recursive: true });
  const origin = serviceOrigin();
  if (origin) {
    // the default service is a declared host permission: saving it asks nothing; another URL still asks on Save
    const manifestFile = join(staging, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), `${origin}/*`])];
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    const file = join(staging, 'lib', 'defaults.js');
    const src = readFileSync(file, 'utf8').replace(
      "export const DEFAULT_SERVICE_URL = '';",
      `export const DEFAULT_SERVICE_URL = ${JSON.stringify(origin)};`,
    );
    writeFileSync(file, src);
  }
  mkdirSync(dirname(out), { recursive: true });
  rmSync(out, { force: true });
  execFileSync('zip', ['-r', '-X', '-q', out, '.', '-x', '*.test.js', '.*', '*/.*', 'store/*'], {
    cwd: staging,
    stdio: 'inherit',
  });
} finally {
  rmSync(staging, { recursive: true, force: true });
}
console.error(`Packed ${out}`);
