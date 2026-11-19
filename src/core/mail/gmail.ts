/** Gmail REST shapes and small helpers shared by the mail read tools and the mail write actions (pure). */

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}

/** users.messages.get (format full | metadata). */
export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string; // unix ms as a decimal string
  sizeEstimate?: number;
  payload?: GmailPart;
}

export interface GmailThread {
  id: string;
  messages?: GmailMessage[];
}

/** Gmail message / thread / attachment-free ids (hex). */
export const GMAIL_ID_RE = /^[0-9a-f]{8,32}$/i;

/** First header of that name (case-insensitive), MIME encoded-words decoded; null when absent. */
export function header(part: GmailPart | undefined, name: string): string | null {
  const lower = name.toLowerCase();
  const h = part?.headers?.find((x) => x.name.toLowerCase() === lower);
  return h ? decodeMimeWords(h.value) : null;
}

function bytesOfBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Narrow: lib.d.ts / workers-types may not list the static yet (workerd and Node 25 have it). */
type Uint8ArrayFromBase64 = {
  fromBase64?: (data: string, opts?: { alphabet?: 'base64' | 'base64url' }) => Uint8Array;
};

/** Bytes of a base64url string (Gmail body.data / attachment data). */
export function bytesOfBase64Url(data: string): Uint8Array<ArrayBuffer> {
  const native = (Uint8Array as unknown as Uint8ArrayFromBase64).fromBase64;
  if (typeof native === 'function') {
    try {
      return native.call(Uint8Array, data, { alphabet: 'base64url' }) as Uint8Array<ArrayBuffer>;
    } catch {
      /* Node < 25 / strict padding: fall through to the loop */
    }
  }
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return bytesOfBase64(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
}

/** MIME charset labels that WHATWG does not name; workerd TextDecoder accepts shift_jis. */
const CHARSET_ALIASES: Record<string, string> = {
  cp932: 'shift_jis',
  ms932: 'shift_jis',
  'windows-31j': 'shift_jis',
  'x-sjis': 'shift_jis',
};

/** Text in a charset label (MIME parameter); unknown labels fall back to UTF-8. */
export function decodeCharset(bytes: Uint8Array, charset: string | null | undefined): string {
  const raw = (charset ?? 'utf-8').trim() || 'utf-8';
  const label = CHARSET_ALIASES[raw.toLowerCase()] ?? raw;
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

function qBytes(text: string): Uint8Array {
  const s = text.replace(/_/g, ' ');
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const hex = s[i] === '=' ? s.slice(i + 1, i + 3) : '';
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      out.push(Number.parseInt(hex, 16));
      i += 2;
    } else out.push(s.charCodeAt(i) & 0xff);
  }
  return Uint8Array.from(out);
}

const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;

/** RFC 2047 encoded-words (=?ISO-2022-JP?B?…?=) to text; whitespace between adjacent words is dropped. */
export function decodeMimeWords(value: string): string {
  if (!value.includes('=?')) return value;
  const joined = value.replace(/\?=\s+=\?/g, '?==?');
  return joined.replace(ENCODED_WORD, (whole, charset: string, enc: string, text: string) => {
    try {
      const bytes = enc.toUpperCase() === 'B' ? bytesOfBase64(text) : qBytes(text);
      return decodeCharset(bytes, charset.split('*')[0]);
    } catch {
      return whole;
    }
  });
}

/** Gmail web link that opens the message (or thread) in the connected account. */
export function gmailWebUrl(address: string, id: string): string {
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(address)}#all/${encodeURIComponent(id)}`;
}
