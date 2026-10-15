import type { Lang } from './time';

/** Public landing page for a UI language (ja is served at the root). */
export function landingPath(lang: Lang): string {
  if (lang === 'en') return '/en/';
  if (lang === 'zh-CN') return '/zh/';
  return '/';
}

/** `?lang=` hand-off from the landing pages: ja / en / zh-CN (zh accepted as zh-CN); anything else is ignored. */
export function parseLangParam(search: string): Lang | null {
  const v = new URLSearchParams(search).get('lang');
  if (v === 'ja' || v === 'en' || v === 'zh-CN') return v;
  if (v === 'zh') return 'zh-CN';
  return null;
}

/** Same URL without the `lang` query parameter, as path + query + hash (other params and the hash are kept). */
export function stripLangParam(href: string): string {
  const url = new URL(href, 'http://localhost');
  url.searchParams.delete('lang');
  return url.pathname + url.search + url.hash;
}
