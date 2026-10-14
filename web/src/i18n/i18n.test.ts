import { describe, expect, it } from 'vitest';
import { DICTIONARIES, LANGS, placeholders, resolveLang, translate } from './core';
import { en } from './en';

const enKeys = Object.keys(en).sort();

describe('dictionaries', () => {
  for (const lang of LANGS) {
    const dict = DICTIONARIES[lang];

    it(`${lang} has exactly the same keys as en`, () => {
      expect(Object.keys(dict).sort()).toEqual(enKeys);
    });

    it(`${lang} uses the same placeholders as en`, () => {
      for (const key of enKeys) {
        const k = key as keyof typeof en;
        expect(placeholders(dict[k]), `${lang}:${key}`).toEqual(placeholders(en[k]));
      }
    });

    it(`${lang} has no empty strings or exclamation marks`, () => {
      for (const [key, value] of Object.entries(dict)) {
        expect(value.trim(), `${lang}:${key}`).not.toBe('');
        expect(value, `${lang}:${key}`).not.toMatch(/[!！]/);
      }
    });
  }

  it('keeps the product name', () => {
    for (const lang of LANGS) expect(DICTIONARIES[lang]['app.name']).toBe('Waseda Moodle MCP');
  });
});

describe('translate', () => {
  it('interpolates variables and leaves unknown ones', () => {
    expect(translate(en, 'overview.pending', { count: 3 })).toBe('Pending approvals: 3');
    expect(translate(en, 'overview.pending')).toBe('Pending approvals: {count}');
  });
});

describe('resolveLang', () => {
  it('prefers the explicit setting', () => {
    expect(resolveLang('zh-CN', ['ja-JP'])).toBe('zh-CN');
  });
  it('follows the browser for auto', () => {
    expect(resolveLang('auto', ['ja-JP', 'en'])).toBe('ja');
    expect(resolveLang('auto', ['zh-TW'])).toBe('zh-CN');
    expect(resolveLang(null, ['fr-FR', 'en-US'])).toBe('en');
    expect(resolveLang(undefined, ['ko'])).toBe('en');
    expect(resolveLang('auto', [])).toBe('en');
  });
});
