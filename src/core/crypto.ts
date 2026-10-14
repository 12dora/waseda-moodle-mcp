/**
 * Web Crypto helpers (Workers + Node 20+). No node:* imports.
 * AES-256-GCM for stored secrets, HMAC-SHA256 (HKDF-derived) for signed tickets.
 */

import type { Signer } from './context';
import { InvalidInput, WmmError } from './errors';
import { nowSec } from './time';

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Accepts base64 and base64url, with or without padding. */
export function b64urlDecode(s: string): Uint8Array {
  let t = s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (t.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(t)) throw new InvalidInput('Invalid base64 data.');
  t += '==='.slice((t.length + 3) % 4);
  let bin: string;
  try {
    bin = atob(t);
  } catch {
    throw new InvalidInput('Invalid base64 data.');
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  let hex = '';
  for (const b of d) hex += b.toString(16).padStart(2, '0');
  return hex;
}

export function randomId(prefix: string, bytes = 16): string {
  return `${prefix}_${b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)))}`;
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** API-key style secret: `wmm_` + base62 carrying ~`bytes`*8 bits of entropy (rejection sampling, no bias). */
export function randomSecret(prefix: string, bytes = 24): string {
  const want = Math.ceil((bytes * 8) / Math.log2(62));
  let out = '';
  while (out.length < want) {
    for (const b of crypto.getRandomValues(new Uint8Array(want * 2))) {
      if (b < 248) {
        out += BASE62[b % 62];
        if (out.length === want) break;
      }
    }
  }
  return `${prefix.endsWith('_') ? prefix : `${prefix}_`}${out}`;
}

/** Constant-time (for equal lengths) string comparison. */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export interface MasterKey {
  /** Returns b64url(iv || ciphertext+tag). */
  encrypt(plain: string): Promise<string>;
  decrypt(enc: string): Promise<string>;
  /** HMAC-SHA256 key derived from the master key (HKDF, info "wmm-signer"). */
  hmacKey: CryptoKey;
}

/** `b64`: 32 raw bytes, base64 or base64url. */
export async function importMasterKey(b64: string): Promise<MasterKey> {
  let raw: Uint8Array;
  try {
    raw = b64urlDecode(b64.trim());
  } catch {
    throw new Error('MASTER_KEY must be 32 random bytes encoded as base64.');
  }
  if (raw.length !== 32) throw new Error('MASTER_KEY must be 32 random bytes encoded as base64.');

  const aes = await crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
  const hkdf = await crypto.subtle.importKey('raw', raw as BufferSource, 'HKDF', false, ['deriveKey']);
  const hmacKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('wmm-signer') },
    hkdf,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );

  return {
    hmacKey,
    async encrypt(plain) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(
        await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, aes, enc.encode(plain)),
      );
      const out = new Uint8Array(12 + ct.length);
      out.set(iv, 0);
      out.set(ct, 12);
      return b64urlEncode(out);
    },
    async decrypt(token) {
      try {
        const buf = b64urlDecode(token);
        if (buf.length < 12 + 16) throw new Error('short');
        const pt = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: buf.subarray(0, 12) as BufferSource },
          aes,
          buf.subarray(12) as BufferSource,
        );
        return dec.decode(pt);
      } catch {
        throw new WmmError('Stored data could not be decrypted.', 'decrypt_failed');
      }
    },
  };
}

/** Ticket = b64url(JSON(payload + {exp})) + "." + b64url(HMAC-SHA256(first part)). */
export function createSigner(key: MasterKey): Signer {
  const mac = async (part: string) => new Uint8Array(await crypto.subtle.sign('HMAC', key.hmacKey, enc.encode(part)));
  return {
    async sign(payload, ttlSec) {
      const body = b64urlEncode(enc.encode(JSON.stringify({ ...payload, exp: nowSec() + ttlSec })));
      return `${body}.${b64urlEncode(await mac(body))}`;
    },
    async verify<T extends Record<string, unknown>>(ticket: string): Promise<T | null> {
      try {
        const parts = ticket.split('.');
        if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
        const mac = b64urlDecode(parts[1]);
        if (b64urlEncode(mac) !== parts[1]) return null; // canonical encoding only
        const ok = await crypto.subtle.verify('HMAC', key.hmacKey, mac as BufferSource, enc.encode(parts[0]));
        if (!ok) return null;
        const payload = JSON.parse(dec.decode(b64urlDecode(parts[0]))) as unknown;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
        const exp = (payload as { exp?: unknown }).exp;
        if (typeof exp !== 'number' || exp < nowSec()) return null;
        return payload as T;
      } catch {
        return null;
      }
    },
  };
}
