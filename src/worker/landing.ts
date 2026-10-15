/**
 * Public landing pages and SEO files (contract §18). `GET /` is the console SPA for visitors carrying the session
 * cookie and the ja landing page for everyone else; `/en/` and `/zh/` are the translations. The pages are static
 * assets carrying the literal placeholder `__PUBLIC_URL__`, replaced with the configured public URL on the way out.
 */

import { Hono } from 'hono';
import { type AppEnv, readSessionCookie } from './auth';
import { type Env, publicUrlOf } from './env';

const PLACEHOLDER = '__PUBLIC_URL__';
/** Sitemap lastmod: the date the landing pages were last changed. */
const BUILD_DATE = '2026-10-15';
const PAGE_CACHE = 'public, max-age=300';
const FILE_CACHE = 'public, max-age=3600';

const ROBOTS_ALLOW = ['/', '/en/', '/zh/', '/privacy'];
const ROBOTS_DISALLOW = [
  '/api/',
  '/mcp',
  '/cal/',
  '/f/',
  '/u/',
  '/oauth/',
  '/authorize',
  '/token',
  '/register',
  '/connect',
];

/** Landing pages with their hreflang code, as built into the asset bundle (dist/<asset>/index.html). */
const LANGUAGE_PAGES = [
  { path: '/', lang: 'ja', asset: '/landing/' },
  { path: '/en/', lang: 'en', asset: '/en/' },
  { path: '/zh/', lang: 'zh-Hans', asset: '/zh/' },
];
const SITEMAP_PAGES = [...LANGUAGE_PAGES.map((p) => p.path), '/privacy'];

const notFound = (): Response => new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });

/** Configured public URL, falling back to the request origin when PUBLIC_URL is unset. */
function baseUrl(request: Request, env: Env): string {
  return publicUrlOf(env) || new URL(request.url).origin;
}

const XML_ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => XML_ENTITIES[ch] ?? ch);
}

/** Fetches a static asset through the binding; null on a miss or a failure. */
async function fetchAsset(request: Request, env: Env, path: string): Promise<Response | null> {
  try {
    const res = await env.ASSETS.fetch(new Request(new URL(path, request.url)));
    return res.ok ? res : null;
  } catch {
    return null;
  }
}

async function landingPage(request: Request, env: Env, assetPath: string): Promise<Response> {
  const asset = await fetchAsset(request, env, assetPath);
  if (!asset) return notFound();
  const html = (await asset.text()).replaceAll(PLACEHOLDER, baseUrl(request, env));
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': PAGE_CACHE,
      Vary: 'Cookie',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** The console SPA shell, unchanged apart from `Vary: Cookie` (the same URL answers differently by cookie). */
async function spaShell(request: Request, env: Env): Promise<Response> {
  const asset = await fetchAsset(request, env, '/');
  if (!asset) return notFound();
  const res = new Response(asset.body, asset);
  res.headers.append('Vary', 'Cookie');
  return res;
}

function redirect(request: Request, path: string): Response {
  const target = new URL(path, request.url);
  target.search = new URL(request.url).search;
  return new Response(null, { status: 301, headers: { Location: target.toString() } });
}

function robotsTxt(base: string): string {
  return [
    'User-agent: *',
    ...ROBOTS_ALLOW.map((p) => `Allow: ${p}`),
    ...ROBOTS_DISALLOW.map((p) => `Disallow: ${p}`),
    '',
    `Sitemap: ${base}/sitemap.xml`,
    '',
  ].join('\n');
}

function sitemapXml(base: string): string {
  const alternates = LANGUAGE_PAGES.map((p) => ({ hreflang: p.lang, href: p.path }));
  alternates.push({ hreflang: 'x-default', href: '/' });
  const links = alternates
    .map((a) => `    <xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${xmlEscape(base + a.href)}"/>`)
    .join('\n');
  const entries = SITEMAP_PAGES.map((path) => {
    const own = LANGUAGE_PAGES.some((p) => p.path === path) ? `\n${links}` : '';
    return `  <url>\n    <loc>${xmlEscape(base + path)}</loc>\n    <lastmod>${BUILD_DATE}</lastmod>${own}\n  </url>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...entries,
    '</urlset>',
    '',
  ].join('\n');
}

const textFile = (body: string, type: string): Response =>
  new Response(body, { headers: { 'Content-Type': type, 'Cache-Control': FILE_CACHE } });

export function landingRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/', (c) =>
    readSessionCookie(c.req.raw) ? spaShell(c.req.raw, c.env) : landingPage(c.req.raw, c.env, '/landing/'),
  );
  for (const page of LANGUAGE_PAGES.slice(1)) {
    app.get(page.path, (c) => landingPage(c.req.raw, c.env, page.asset));
    app.get(page.path.slice(0, -1), (c) => redirect(c.req.raw, page.path));
  }
  app.get('/landing/*', (c) => redirect(c.req.raw, '/'));

  app.get('/robots.txt', (c) => textFile(robotsTxt(baseUrl(c.req.raw, c.env)), 'text/plain; charset=utf-8'));
  app.get('/sitemap.xml', (c) => textFile(sitemapXml(baseUrl(c.req.raw, c.env)), 'application/xml; charset=utf-8'));

  return app;
}
