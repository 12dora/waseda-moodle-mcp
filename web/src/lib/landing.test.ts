import { describe, expect, it } from 'vitest';
import { landingPath, parseLangParam, stripLangParam } from './landing';

describe('landingPath', () => {
  it('maps each UI language to its landing page', () => {
    expect(landingPath('ja')).toBe('/');
    expect(landingPath('en')).toBe('/en/');
    expect(landingPath('zh-CN')).toBe('/zh/');
  });
});

describe('parseLangParam', () => {
  it('accepts supported languages', () => {
    expect(parseLangParam('?lang=ja')).toBe('ja');
    expect(parseLangParam('?lang=en')).toBe('en');
    expect(parseLangParam('?lang=zh-CN')).toBe('zh-CN');
    expect(parseLangParam('?return=%2Fsettings&lang=en')).toBe('en');
  });

  it('accepts zh as zh-CN', () => {
    expect(parseLangParam('?lang=zh')).toBe('zh-CN');
  });

  it('ignores missing or invalid values', () => {
    expect(parseLangParam('')).toBeNull();
    expect(parseLangParam('?lang=')).toBeNull();
    expect(parseLangParam('?lang=fr')).toBeNull();
    expect(parseLangParam('?lang=auto')).toBeNull();
    expect(parseLangParam('?lang=EN')).toBeNull();
  });
});

describe('stripLangParam', () => {
  it('removes only lang and keeps other params and the hash', () => {
    expect(stripLangParam('https://example.com/connect?lang=en&code=abc#x')).toBe('/connect?code=abc#x');
    expect(stripLangParam('https://example.com/connect?return=%2Fsettings&lang=ja')).toBe(
      '/connect?return=%2Fsettings',
    );
  });

  it('drops the query entirely when lang was the only param', () => {
    expect(stripLangParam('https://example.com/privacy?lang=zh-CN')).toBe('/privacy');
  });

  it('leaves URLs without lang unchanged', () => {
    expect(stripLangParam('https://example.com/oauth/consent?req=1')).toBe('/oauth/consent?req=1');
  });
});
