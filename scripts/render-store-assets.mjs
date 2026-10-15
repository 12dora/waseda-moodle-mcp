#!/usr/bin/env node
// Renders extension/store/*.svg to PNG next to each SVG. Optional: uses playwright-core's Chromium when it is
// resolvable (not a project dependency); otherwise prints how to render the files by hand.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const storeDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'store');
const svgs = readdirSync(storeDir).filter((f) => f.endsWith('.svg'));

function svgSize(svg) {
  const w = svg.match(/\bwidth="(\d+)"/);
  const h = svg.match(/\bheight="(\d+)"/);
  return { width: Number(w?.[1] ?? 128), height: Number(h?.[1] ?? 128) };
}

async function loadChromium() {
  try {
    return (await import('playwright-core')).chromium;
  } catch {
    return null;
  }
}

const chromium = await loadChromium();
if (!chromium) {
  console.error('playwright-core is not installed; render manually, e.g.:');
  for (const f of svgs) {
    console.error(`  rsvg-convert -o ${join(storeDir, f.replace(/\.svg$/, '.png'))} ${join(storeDir, f)}`);
  }
  console.error('or temporarily install playwright-core (do not commit the dependency) and rerun this script.');
  process.exit(0);
}

const browser = await chromium.launch();
try {
  for (const f of svgs) {
    const svg = readFileSync(join(storeDir, f), 'utf8');
    const viewport = svgSize(svg);
    const page = await browser.newPage({ viewport });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
    const png = join(storeDir, f.replace(/\.svg$/, '.png'));
    await page.screenshot({ path: png, omitBackground: true });
    await page.close();
    console.error(`Rendered ${png}`);
  }
} finally {
  await browser.close();
}
