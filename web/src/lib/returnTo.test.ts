import { describe, expect, it } from 'vitest';
import { isSafeRedirect, safeReturn } from './returnTo';

const O = 'https://wasemoodle.example.com';

describe('safeReturn', () => {
  it('accepts same-origin paths', () => {
    expect(safeReturn('/oauth/consent?req=abc', O)).toBe('/oauth/consent?req=abc');
    expect(safeReturn('/settings#hidden', O)).toBe('/settings#hidden');
  });

  it('rejects other origins and protocol-relative tricks', () => {
    expect(safeReturn('//evil.example.com', O)).toBeNull();
    expect(safeReturn('/\\evil.example.com', O)).toBeNull();
    expect(safeReturn('https://evil.example.com', O)).toBeNull();
  });

  it('rejects control characters and whitespace', () => {
    expect(safeReturn('/\t/evil.example.com', O)).toBeNull();
    expect(safeReturn('/\n/evil.example.com', O)).toBeNull();
    expect(safeReturn(decodeURIComponent('/%09/evil.example.com'), O)).toBeNull();
    expect(safeReturn(decodeURIComponent('/%0A/evil.example.com'), O)).toBeNull();
  });

  it('keeps encoded characters encoded', () => {
    expect(safeReturn('/%09/x', O)).toBe('/%09/x');
  });

  it('rejects /connect and empty values', () => {
    expect(safeReturn('/connect?return=/', O)).toBeNull();
    expect(safeReturn(null, O)).toBeNull();
    expect(safeReturn('', O)).toBeNull();
  });
});

describe('isSafeRedirect', () => {
  it('allows http(s) and custom app schemes', () => {
    expect(isSafeRedirect('https://claude.ai/api/mcp/auth_callback?code=x', O)).toBe(true);
    expect(isSafeRedirect('http://localhost:33418/callback', O)).toBe(true);
    expect(isSafeRedirect('cursor://oauth/callback', O)).toBe(true);
  });

  it('refuses script-capable schemes', () => {
    expect(isSafeRedirect('javascript:alert(1)', O)).toBe(false);
    expect(isSafeRedirect('JavaScript:alert(1)', O)).toBe(false);
    expect(isSafeRedirect('data:text/html,x', O)).toBe(false);
    expect(isSafeRedirect('vbscript:x', O)).toBe(false);
  });
});
