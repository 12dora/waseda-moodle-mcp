import { describe, expect, it } from 'vitest';
import { hasConsentFor, makeConsent, privacyUrl } from './consent.js';

describe('consent', () => {
  const url = 'https://wasemoodle.example.com';
  it('matches only the URL it was given for', () => {
    const c = makeConsent(url, 1);
    expect(c).toEqual({ serviceUrl: url, at: 1 });
    expect(hasConsentFor(c, url)).toBe(true);
    expect(hasConsentFor(c, 'https://other.example.com')).toBe(false);
  });
  it('rejects missing consent or URL', () => {
    expect(hasConsentFor(undefined, url)).toBe(false);
    expect(hasConsentFor(null, url)).toBe(false);
    expect(hasConsentFor('yes', url)).toBe(false);
    expect(hasConsentFor(makeConsent(url), undefined)).toBe(false);
  });
  it('builds the privacy URL', () => {
    expect(privacyUrl(url)).toBe('https://wasemoodle.example.com/privacy');
  });
});
