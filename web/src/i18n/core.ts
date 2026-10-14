import type { UiLang } from '../api/types';
import type { Lang } from '../lib/time';
import { type Dictionary, en, type MessageKey } from './en';
import { ja } from './ja';
import { zhCN } from './zh-CN';

export type { Lang, MessageKey };

export const LANGS: readonly Lang[] = ['ja', 'en', 'zh-CN'];

/** Native names, identical in every UI language. */
export const LANG_NAMES: Record<Lang, string> = { ja: '日本語', en: 'English', 'zh-CN': '简体中文' };

export const DICTIONARIES: Record<Lang, Dictionary> = { ja, en, 'zh-CN': zhCN };

/** Explicit setting wins; 'auto' follows the browser (ja / zh* / everything else → en). */
export function resolveLang(uiLang: UiLang | null | undefined, browserLangs: readonly string[]): Lang {
  if (uiLang && uiLang !== 'auto') return uiLang;
  for (const raw of browserLangs) {
    const l = raw.toLowerCase();
    if (l === 'ja' || l.startsWith('ja-')) return 'ja';
    if (l === 'zh' || l.startsWith('zh-')) return 'zh-CN';
    if (l === 'en' || l.startsWith('en-')) return 'en';
  }
  return 'en';
}

export type Vars = Record<string, string | number>;
export type Translate = (key: MessageKey, vars?: Vars) => string;

export function translate(dict: Dictionary, key: MessageKey, vars?: Vars): string {
  const s = dict[key] ?? en[key] ?? key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

export function placeholders(s: string): string[] {
  return [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();
}
