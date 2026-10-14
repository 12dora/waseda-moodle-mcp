/**
 * Moodle mobile launch payloads.
 * `<scheme>://token=<base64("<md5(wwwroot+passport)>:::<32-hex token>[:::<privatetoken>]")>`
 */

import { InvalidInput } from '../errors';

export const MOODLE_URL = 'https://wsdmoodle.waseda.jp';

export interface LaunchToken {
  token: string;
  privateToken: string | null;
  /** md5(MOODLE_URL + passport) === signature field; null when it cannot be checked. */
  signatureOk: boolean | null;
}

const BAD_LAUNCH =
  'Could not read the Moodle launch link. Copy the whole link that starts with "ltgopenlmsapp://" and try again.';

const HEX32 = /^[0-9a-f]{32}$/i;

/** Surrounding quotes / brackets / whitespace that copy-paste tends to add. */
function stripWrapping(s: string): string {
  let a = 0;
  let b = s.length;
  const junk = (c: string) => /[\s"'`<>()[\]]/.test(c);
  while (a < b && junk(s.charAt(a))) a++;
  while (b > a && junk(s.charAt(b - 1))) b--;
  return s.slice(a, b);
}

/** Base64 / base64url (padding optional) -> binary string, or null. */
function decodeB64(s: string): string | null {
  let t = s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (!t || t.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(t)) return null;
  t += '==='.slice((t.length + 3) % 4);
  try {
    return atob(t);
  } catch {
    return null;
  }
}

interface Payload {
  sig: string;
  token: string;
  privateToken: string | null;
}

function parseDecoded(bin: string): Payload | null {
  const [sig, rawToken, rawPrivate = ''] = bin.split(':::');
  const token = rawToken?.trim() ?? '';
  if (sig === undefined || !HEX32.test(token)) return null;
  const pt = rawPrivate.trim();
  return {
    sig: sig.trim().toLowerCase(),
    token: token.toLowerCase(),
    privateToken: /^[A-Za-z0-9]{8,128}$/.test(pt) ? pt : null,
  };
}

function parsePayload(payload: string): Payload | null {
  // A '+' turned into a space by form decoding is the only whitespace that can be meaningful.
  const candidates = /\s/.test(payload) ? [payload.replace(/\s/g, '+'), payload.replace(/\s+/g, '')] : [payload];
  for (const c of candidates) {
    const bin = decodeB64(c);
    const parsed = bin === null ? null : parseDecoded(bin);
    if (parsed) return parsed;
  }
  return null;
}

/** The part after `token=` of a `<scheme>://token=…` URL (or the whole input when it is not one). */
function extractPayload(s: string): string {
  const rest = /^[a-z][a-z0-9+.-]*:\/\/([\s\S]*)$/i.exec(s)?.[1];
  if (rest === undefined) return /^token=/i.test(s) ? s.slice(6) : s;
  return /(?:^|[?&#])token=([^&#]*)/i.exec(rest)?.[1] ?? rest;
}

/**
 * Accepts: `<scheme>://token=<b64>` (any scheme, also URL-encoded), the bare base64 payload, or a bare 32-hex token.
 * Never echoes the input in error messages.
 */
export function parseLaunch(input: string, passport?: string): LaunchToken {
  if (typeof input !== 'string' || input.length > 4096) throw new InvalidInput(BAD_LAUNCH);
  let s = stripWrapping(input);
  if (!s) throw new InvalidInput('Paste the Moodle launch link first.');

  if (/%[0-9a-f]{2}/i.test(s)) {
    try {
      s = decodeURIComponent(s);
    } catch {
      /* keep as is */
    }
    s = stripWrapping(s);
  }

  const payload = stripWrapping(extractPayload(s));
  if (HEX32.test(payload)) return { token: payload.toLowerCase(), privateToken: null, signatureOk: null };

  const p = parsePayload(payload);
  if (!p) throw new InvalidInput(BAD_LAUNCH);
  return {
    token: p.token,
    privateToken: p.privateToken,
    signatureOk: passport ? md5Hex(MOODLE_URL + passport) === p.sig : null,
  };
}

/** confirmed=1 launch URL: the page returns HTML with `<a id="launchapp">` instead of redirecting. */
export function launchUrl(passport: string, confirmed = true): string {
  return (
    `${MOODLE_URL}/admin/tool/mobile/launch.php?service=moodle_mobile_app` +
    `&passport=${encodeURIComponent(passport)}&urlscheme=moodlemobile${confirmed ? '&confirmed=1' : ''}`
  );
}

// ---------------------------------------------------------------- MD5 (Web Crypto has none; integrity check only)

const MD5_SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_K = Int32Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296));

function md5F(i: number, b: number, c: number, d: number): number {
  if (i < 16) return (b & c) | (~b & d);
  if (i < 32) return (d & b) | (~d & c);
  if (i < 48) return b ^ c ^ d;
  return c ^ (b | ~d);
}

function md5G(i: number): number {
  if (i < 16) return i;
  if (i < 32) return (5 * i + 1) & 15;
  if (i < 48) return (3 * i + 5) & 15;
  return (7 * i) & 15;
}

/** Pads the message and returns it as little-endian 32-bit words. */
function md5Words(msg: Uint8Array): Int32Array {
  const n = msg.length;
  const w = new Int32Array((((n + 8) >> 6) + 1) << 4);
  for (let i = 0; i < n; i++) w[i >> 2] = (w[i >> 2] ?? 0) | ((msg[i] ?? 0) << ((i & 3) * 8));
  w[n >> 2] = (w[n >> 2] ?? 0) | (0x80 << ((n & 3) * 8));
  w[w.length - 2] = n * 8;
  w[w.length - 1] = Math.floor((n * 8) / 4294967296);
  return w;
}

function md5Block(state: Int32Array, w: Int32Array, off: number): void {
  const [a0 = 0, b0 = 0, c0 = 0, d0 = 0] = state;
  let [a, b, c, d] = [a0, b0, c0, d0];
  for (let i = 0; i < 64; i++) {
    const f = (md5F(i, b, c, d) + a + (MD5_K[i] ?? 0) + (w[off + md5G(i)] ?? 0)) | 0;
    const shift = MD5_SHIFTS[(i >> 4) * 4 + (i & 3)] ?? 0;
    a = d;
    d = c;
    c = b;
    b = (b + ((f << shift) | (f >>> (32 - shift)))) | 0;
  }
  state[0] = (a0 + a) | 0;
  state[1] = (b0 + b) | 0;
  state[2] = (c0 + c) | 0;
  state[3] = (d0 + d) | 0;
}

export function md5Hex(input: string): string {
  const w = md5Words(new TextEncoder().encode(input));
  const state = Int32Array.of(0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476);
  for (let off = 0; off < w.length; off += 16) md5Block(state, w, off);
  const out = new DataView(new ArrayBuffer(16));
  state.forEach((v, i) => {
    out.setInt32(i * 4, v, true);
  });
  return Array.from(new Uint8Array(out.buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
