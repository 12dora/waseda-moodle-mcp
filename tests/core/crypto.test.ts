import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  b64urlDecode,
  b64urlEncode,
  createSigner,
  importMasterKey,
  randomId,
  randomSecret,
  sha256Hex,
  timingSafeEqual,
} from '../../src/core/crypto';

const keyB64 = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));

afterEach(() => vi.useRealTimers());

describe('base64url', () => {
  it('round-trips and uses the url-safe alphabet without padding', () => {
    expect(b64urlEncode(new Uint8Array([251, 255]))).toBe('-_8');
    expect(Array.from(b64urlDecode('-_8'))).toEqual([251, 255]);
    const bytes = crypto.getRandomValues(new Uint8Array(1000));
    expect(Array.from(b64urlDecode(b64urlEncode(bytes)))).toEqual(Array.from(bytes));
  });

  it('decodes standard base64 with padding too', () => {
    expect(Array.from(b64urlDecode('+/8='))).toEqual([251, 255]);
  });

  it('rejects garbage', () => {
    expect(() => b64urlDecode('not base64!')).toThrow();
  });
});

describe('sha256Hex / random', () => {
  it('matches the known vector', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('randomId has the prefix and is unique', () => {
    const a = randomId('act');
    expect(a).toMatch(/^act_[A-Za-z0-9_-]{22}$/);
    expect(randomId('act')).not.toBe(a);
  });

  it('randomSecret is wmm_ + base62', () => {
    expect(randomSecret('wmm')).toMatch(/^wmm_[0-9A-Za-z]{33}$/);
    expect(randomSecret('wmm_')).toMatch(/^wmm_[0-9A-Za-z]{33}$/);
    expect(randomSecret('wmm')).not.toBe(randomSecret('wmm'));
  });
});

describe('timingSafeEqual', () => {
  it('compares strings', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });
});

describe('MasterKey', () => {
  it('encrypts and decrypts (random IV each time)', async () => {
    const key = await importMasterKey(keyB64);
    const a = await key.encrypt('0123456789abcdef0123456789abcdef');
    const b = await key.encrypt('0123456789abcdef0123456789abcdef');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await key.decrypt(a)).toBe('0123456789abcdef0123456789abcdef');
    expect(await key.decrypt(await key.encrypt('日本語 ✓'))).toBe('日本語 ✓');
  });

  it('accepts base64url and rejects other lengths', async () => {
    await expect(importMasterKey(b64urlEncode(new Uint8Array(32).fill(9)))).resolves.toBeTruthy();
    await expect(importMasterKey(b64urlEncode(new Uint8Array(16)))).rejects.toThrow(/32/);
    await expect(importMasterKey('%%%')).rejects.toThrow(/32/);
  });

  it('fails to decrypt tampered data or data from another key', async () => {
    const key = await importMasterKey(keyB64);
    const other = await importMasterKey(b64urlEncode(new Uint8Array(32).fill(5)));
    const enc = await key.encrypt('secret');
    await expect(other.decrypt(enc)).rejects.toMatchObject({ code: 'decrypt_failed' });
    const bytes = b64urlDecode(enc);
    bytes[bytes.length - 1]! ^= 1;
    await expect(key.decrypt(b64urlEncode(bytes))).rejects.toMatchObject({ code: 'decrypt_failed' });
    await expect(key.decrypt('abc')).rejects.toMatchObject({ code: 'decrypt_failed' });
  });
});

describe('Signer', () => {
  it('signs and verifies a payload', async () => {
    const signer = createSigner(await importMasterKey(keyB64));
    const t = await signer.sign({ k: 'dl', u: 7 }, 60);
    expect(t).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const p = await signer.verify<{ k: string; u: number; exp: number }>(t);
    expect(p).toMatchObject({ k: 'dl', u: 7 });
    expect(typeof p?.exp).toBe('number');
  });

  it('rejects tampered payloads, tampered signatures and other keys', async () => {
    const key = await importMasterKey(keyB64);
    const signer = createSigner(key);
    const t = await signer.sign({ u: 1 }, 60);
    const [body, sig] = t.split('.') as [string, string];
    const forged = b64urlEncode(new TextEncoder().encode(JSON.stringify({ u: 2, exp: 9999999999 })));
    expect(await signer.verify(`${forged}.${sig}`)).toBeNull();
    expect(await signer.verify(`${body}.${sig[0] === 'A' ? 'B' : 'A'}${sig.slice(1)}`)).toBeNull();
    expect(await signer.verify(body)).toBeNull();
    expect(await signer.verify('')).toBeNull();
    expect(await signer.verify('a.b.c')).toBeNull();
    const other = createSigner(await importMasterKey(b64urlEncode(new Uint8Array(32).fill(5))));
    expect(await other.verify(t)).toBeNull();
  });

  it('rejects non-canonical MAC encodings', async () => {
    const signer = createSigner(await importMasterKey(keyB64));
    const t = await signer.sign({ u: 1 }, 60);
    expect(await signer.verify(t)).not.toBeNull();
    expect(await signer.verify(`${t}=`)).toBeNull();
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = t[t.length - 1]!;
    const sibling = alphabet[alphabet.indexOf(last) ^ 1]!; // differs only in the 2 unused trailing bits
    expect(await signer.verify(`${t.slice(0, -1)}${sibling}`)).toBeNull();
  });

  it('rejects expired tickets', async () => {
    const signer = createSigner(await importMasterKey(keyB64));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T00:00:00Z'));
    const t = await signer.sign({ u: 1 }, 60);
    vi.setSystemTime(new Date('2026-10-14T00:00:30Z'));
    expect(await signer.verify(t)).not.toBeNull();
    vi.setSystemTime(new Date('2026-10-14T00:01:30Z'));
    expect(await signer.verify(t)).toBeNull();
  });
});
