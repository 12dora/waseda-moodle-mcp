import { describe, expect, it } from 'vitest';
import { createApi } from '../../src/worker/api';
import { SESSION_COOKIE } from '../../src/worker/auth';
import type { Env } from '../../src/worker/env';

const ORIGIN = 'https://wasemoodle.example.com';
const SPA = '<!doctype html><title>console</title>';
const PAGES: Record<string, string> = {
  '/': SPA,
  '/landing/': '<html lang="ja"><link href="__PUBLIC_URL__/"><a href="__PUBLIC_URL__/mcp">__PUBLIC_URL__</a></html>',
  '/en/': '<html lang="en"><link rel="canonical" href="__PUBLIC_URL__/en/"></html>',
  '/zh/': '<html lang="zh"><link rel="canonical" href="__PUBLIC_URL__/zh/"></html>',
};

const app = createApi();
const requested: string[] = [];

function makeEnv(over: Partial<Env> = {}, pages: Record<string, string> = PAGES): Env {
  const assets = {
    fetch: async (req: Request) => {
      const path = new URL(req.url).pathname;
      requested.push(path);
      const body = pages[path];
      return body === undefined ? new Response('missing', { status: 404 }) : new Response(body, { status: 200 });
    },
  } as unknown as Fetcher;
  return { ASSETS: assets, PUBLIC_URL: ORIGIN, ...over } as Env;
}

const call = (path: string, init: RequestInit = {}, env: Env = makeEnv()) =>
  app.fetch(new Request(`${ORIGIN}${path}`, init), env);

describe('GET /', () => {
  it('serves the ja landing page with every placeholder replaced when there is no session cookie', async () => {
    requested.length = 0;
    const res = await call('/');
    expect(res.status).toBe(200);
    expect(requested).toEqual(['/landing/']);
    const html = await res.text();
    expect(html).toBe(`<html lang="ja"><link href="${ORIGIN}/"><a href="${ORIGIN}/mcp">${ORIGIN}</a></html>`);
    expect(html).not.toContain('__PUBLIC_URL__');
  });

  it('sets the content type, cache and vary headers', async () => {
    const res = await call('/');
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(res.headers.get('Vary')).toBe('Cookie');
  });

  it('serves the SPA shell untouched when the session cookie is present', async () => {
    requested.length = 0;
    const res = await call('/', { headers: { Cookie: `other=1; ${SESSION_COOKIE}=abc` } });
    expect(requested).toEqual(['/']);
    expect(await res.text()).toBe(SPA);
    expect(res.headers.get('Vary')).toContain('Cookie');
  });

  it('treats an empty session cookie as signed out', async () => {
    const res = await call('/', { headers: { Cookie: `${SESSION_COOKIE}=` } });
    expect(await res.text()).toContain('lang="ja"');
  });

  it('answers HEAD with the same headers and no body', async () => {
    const res = await call('/', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('Vary')).toBe('Cookie');
    expect(await res.text()).toBe('');
  });

  it('falls back to the request origin when PUBLIC_URL is unset', async () => {
    const res = await call('/', {}, makeEnv({ PUBLIC_URL: '' }));
    expect(await res.text()).toContain(`href="${ORIGIN}/"`);
  });

  it('strips trailing slashes from PUBLIC_URL', async () => {
    const res = await call('/', {}, makeEnv({ PUBLIC_URL: `${ORIGIN}//` }));
    expect(await res.text()).toContain(`href="${ORIGIN}/mcp"`);
  });

  it('answers 404 when the asset is missing', async () => {
    const res = await call('/', {}, makeEnv({}, {}));
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('answers 404 when the assets binding throws', async () => {
    const env = makeEnv({
      ASSETS: {
        fetch: async () => {
          throw new Error('boom');
        },
      } as unknown as Fetcher,
    });
    expect((await call('/', {}, env)).status).toBe(404);
  });
});

describe('/en/ and /zh/', () => {
  it.each(['en', 'zh'])('serves /%s/ with the same headers and replacement', async (lang) => {
    const res = await call(`/${lang}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(res.headers.get('Vary')).toBe('Cookie');
    expect(await res.text()).toContain(`href="${ORIGIN}/${lang}/"`);
  });

  it('ignores the session cookie on the translations', async () => {
    const res = await call('/en/', { headers: { Cookie: `${SESSION_COOKIE}=abc` } });
    expect(await res.text()).toContain('lang="en"');
  });

  it.each(['en', 'zh'])('redirects /%s to the trailing slash with 301', async (lang) => {
    const res = await call(`/${lang}?utm=1`);
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe(`${ORIGIN}/${lang}/?utm=1`);
  });

  it('answers 404 when the asset is missing', async () => {
    expect((await call('/zh/', {}, makeEnv({}, {}))).status).toBe(404);
  });
});

describe('Web Analytics beacon', () => {
  const TOKEN = '0123456789abcdef0123456789abcdef';
  const BEACON = `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"${TOKEN}"}'></script>`;
  const BODY = '<html><body><p>hi</p></body></html>';
  const pages = { ...PAGES, '/landing/': BODY, '/en/': BODY, '/zh/': BODY };

  it.each(['/', '/en/', '/zh/'])('is injected right before </body> on %s when the token is valid', async (path) => {
    const html = await (await call(path, {}, makeEnv({ CF_BEACON_TOKEN: TOKEN }, pages))).text();
    expect(html).toBe(`<html><body><p>hi</p>${BEACON}</body></html>`);
  });

  it.each([undefined, '', 'not-a-token', TOKEN.toUpperCase(), `${TOKEN}0`, `${TOKEN}"}'<x>`])(
    'is absent when the token is %j',
    async (token) => {
      const html = await (await call('/', {}, makeEnv({ CF_BEACON_TOKEN: token }, pages))).text();
      expect(html).toBe(BODY);
    },
  );

  it('is not added to the SPA shell, robots.txt or sitemap.xml', async () => {
    const env = makeEnv({ CF_BEACON_TOKEN: TOKEN }, { ...pages, '/': '<body></body>' });
    const spa = await call('/', { headers: { Cookie: `${SESSION_COOKIE}=abc` } }, env);
    expect(await spa.text()).not.toContain('cloudflareinsights');
    expect(await (await call('/robots.txt', {}, env)).text()).not.toContain('cloudflareinsights');
    expect(await (await call('/sitemap.xml', {}, env)).text()).not.toContain('cloudflareinsights');
  });
});

describe('/landing/*', () => {
  it.each(['/landing/', '/landing/index.html', '/landing/x'])('redirects %s to / with 301', async (path) => {
    const res = await call(path);
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe(`${ORIGIN}/`);
  });
});

describe('GET /robots.txt', () => {
  it('allows the public pages, blocks the machine endpoints and points to the sitemap', async () => {
    const res = await call('/robots.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    const lines = (await res.text()).split('\n');
    expect(lines[0]).toBe('User-agent: *');
    for (const p of ['/', '/en/', '/zh/', '/privacy']) expect(lines).toContain(`Allow: ${p}`);
    const blocked = ['/api/', '/mcp', '/cal/', '/f/', '/u/', '/oauth/', '/authorize', '/token', '/register'];
    blocked.push('/connect');
    for (const p of blocked) expect(lines).toContain(`Disallow: ${p}`);
    expect(lines).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
  });
});

describe('GET /sitemap.xml', () => {
  const locs = (xml: string) => [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);

  it('lists the four pages with lastmod and hreflang alternates on the landing pages', async () => {
    const res = await call('/sitemap.xml');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/xml; charset=utf-8');
    const xml = await res.text();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
    expect(locs(xml)).toEqual([`${ORIGIN}/`, `${ORIGIN}/en/`, `${ORIGIN}/zh/`, `${ORIGIN}/privacy`]);
    expect(xml.match(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/g)).toHaveLength(4);
    for (const [lang, path] of [
      ['ja', '/'],
      ['en', '/en/'],
      ['zh-Hans', '/zh/'],
      ['x-default', '/'],
    ]) {
      expect(xml).toContain(`<xhtml:link rel="alternate" hreflang="${lang}" href="${ORIGIN}${path}"/>`);
    }
    // three landing pages x four alternates; /privacy has none
    expect(xml.match(/<xhtml:link /g)).toHaveLength(12);
    expect(xml.match(/<url>/g)).toHaveLength(4);
    expect(xml.match(/<\/url>/g)).toHaveLength(4);
  });

  it('escapes XML special characters in PUBLIC_URL', async () => {
    const res = await call('/sitemap.xml', {}, makeEnv({ PUBLIC_URL: 'https://a.example.com/?x=1&y=<2>' }));
    const xml = await res.text();
    expect(xml).toContain('https://a.example.com/?x=1&amp;y=&lt;2&gt;/en/');
    expect(xml).not.toContain('&y=<2>');
  });
});
