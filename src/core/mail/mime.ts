/** RFC 5322 / 2047 message builder and address-list parser (pure; Gmail supplies From / Date / Message-ID). */

import { b64urlEncode } from '../crypto';
import { InvalidInput } from '../errors';

export interface Mailbox {
  name: string;
  address: string;
}

interface MessageParts {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}

const utf8 = new TextEncoder();
/** RFC 2047 encoded-word ≤ 75 chars: `=?UTF-8?B?` + `?=` leaves 63 of base64 → 45 bytes. */
const WORD_BYTES = 45;
const SPECIALS = /[()<>[\]:;@\\,."]/;
const FOLD = ',\r\n ';
const REF_FOLD = '\r\n ';
/** addr-spec without quotes, comments, groups, or spaces. */
const ADDR_RE = /^[^@\s<>"(),;:]+@[^@\s<>"(),;:]+\.[^@\s<>"(),;:]+$/;

export function rejectNl(value: string, label: string): void {
  if (/[\r\n]/.test(value)) throw new InvalidInput(`The ${label} contains a newline.`);
}

function unquoteName(name: string): string {
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
    return name.slice(1, -1).replace(/\\([\\"])/g, '$1');
  }
  return name;
}

function fromAngle(item: string): Mailbox | null {
  if (!item.endsWith('>')) return null;
  const lt = item.lastIndexOf('<');
  if (lt < 0) return null;
  const address = item.slice(lt + 1, -1).trim();
  if (!address) return null;
  return { name: unquoteName(item.slice(0, lt).trim()), address };
}

/** One mailbox: `addr`, `<addr>`, or `Name <addr>` (Name may contain commas). */
function parseMailbox(item: string): Mailbox | null {
  const trimmed = item.trim();
  if (!trimmed) return null;
  return fromAngle(trimmed) ?? { name: '', address: trimmed };
}

export function requireMailbox(item: string, label: string): Mailbox {
  rejectNl(item, label);
  const m = parseMailbox(item);
  if (!m || !ADDR_RE.test(m.address)) throw new InvalidInput(`Invalid ${label} address.`);
  return m;
}

interface Scan {
  out: string;
  quoted: boolean;
  escape: boolean;
  depth: number;
}

function skipEscape(s: Scan, ch: string): boolean {
  if (s.escape) {
    if (s.depth === 0) s.out += ch;
    s.escape = false;
    return true;
  }
  if (ch !== '\\' || !(s.quoted || s.depth > 0)) return false;
  s.escape = true;
  if (s.depth === 0) s.out += ch;
  return true;
}

function takeCommentDepth(s: Scan, ch: string): boolean {
  if (s.depth === 0) return false;
  if (ch === '(') s.depth++;
  else if (ch === ')') s.depth--;
  return true;
}

function skipComment(s: Scan, ch: string): boolean {
  if (takeCommentDepth(s, ch)) return true;
  if (s.quoted) {
    if (ch === '"') s.quoted = false;
    s.out += ch;
    return true;
  }
  if (ch === '"') {
    s.quoted = true;
    s.out += ch;
    return true;
  }
  if (ch !== '(') return false;
  s.depth++;
  return true;
}

/** RFC 2047 encoded-word `=?…?=` is an atom (commas / parens inside must not be parsed). */
function takeEncoded(s: string, i: number, locked: boolean): { word: string; next: number } | null {
  if (locked || s[i] !== '=' || s[i + 1] !== '?') return null;
  const end = s.indexOf('?=', i + 2);
  if (end < 0) return null;
  return { word: s.slice(i, end + 2), next: end + 1 };
}

/** Drop RFC 5322 comments `(…)` outside quoted strings and encoded-words. */
function stripComments(value: string): string {
  const s: Scan = { out: '', quoted: false, escape: false, depth: 0 };
  for (let i = 0; i < value.length; i++) {
    const taken = takeEncoded(value, i, s.quoted || s.escape || s.depth > 0);
    if (taken) {
      s.out += taken.word;
      i = taken.next;
      continue;
    }
    const ch = value[i] ?? '';
    if (skipEscape(s, ch) || skipComment(s, ch)) continue;
    s.out += ch;
  }
  return s.out;
}

interface SplitState {
  items: string[];
  cur: string;
  quoted: boolean;
  escape: boolean;
  angles: number;
}

function flushItem(state: SplitState): void {
  const t = state.cur.trim();
  if (t) state.items.push(t);
  state.cur = '';
}

function takeQuote(state: SplitState, ch: string): boolean {
  if (state.quoted && ch === '\\') {
    state.cur += ch;
    state.escape = true;
    return true;
  }
  if (ch !== '"') return false;
  state.quoted = !state.quoted;
  state.cur += ch;
  return true;
}

function takeAngle(state: SplitState, ch: string): void {
  if (state.quoted) return;
  if (ch === '<') state.angles++;
  else if (ch === '>' && state.angles > 0) state.angles--;
}

/** Group `name:` … `;` and mailbox commas; encoded-words and quoted / angle regions are not split. */
function takeDelimiter(state: SplitState, ch: string): boolean {
  if (state.quoted || state.angles > 0) return false;
  if (ch === ':') {
    state.cur = '';
    return true;
  }
  if (ch !== ',' && ch !== ';') return false;
  flushItem(state);
  return true;
}

function splitAddressList(value: string): string[] {
  const s = stripComments(value);
  const state: SplitState = { items: [], cur: '', quoted: false, escape: false, angles: 0 };
  for (let i = 0; i < s.length; i++) {
    const taken = takeEncoded(s, i, state.quoted || state.escape);
    if (taken) {
      state.cur += taken.word;
      i = taken.next;
      continue;
    }
    const ch = s[i] ?? '';
    if (state.escape) {
      state.cur += ch;
      state.escape = false;
      continue;
    }
    if (takeQuote(state, ch)) continue;
    takeAngle(state, ch);
    if (takeDelimiter(state, ch)) continue;
    state.cur += ch;
  }
  flushItem(state);
  return state.items;
}

/** Header value → valid mailboxes, including `"Last, First" <addr>` lists, groups, and comments. */
export function parseAddressList(value: string): Mailbox[] {
  const out: Mailbox[] = [];
  for (const item of splitAddressList(value)) {
    const m = parseMailbox(item);
    if (m && ADDR_RE.test(m.address)) out.push(m);
  }
  return out;
}

function base64Std(bytes: Uint8Array): string {
  const url = b64urlEncode(bytes);
  return url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (url.length % 4)) % 4);
}

function wrap76(s: string): string {
  if (!s) return s;
  const lines: string[] = [];
  for (let i = 0; i < s.length; i += 76) lines.push(s.slice(i, i + 76));
  return lines.join('\r\n');
}

function crlf(text: string): string {
  return text.replace(/\r\n|\r|\n/g, '\r\n');
}

function utf8End(bytes: Uint8Array, start: number): number {
  let end = Math.min(start + WORD_BYTES, bytes.length);
  while (end > start && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return end > start ? end : Math.min(start + WORD_BYTES, bytes.length);
}

function encodeRfc2047(text: string): string {
  const bytes = utf8.encode(text);
  const words: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    const end = utf8End(bytes, i);
    words.push(`=?UTF-8?B?${base64Std(bytes.subarray(i, end))}?=`);
    i = end;
  }
  return words.join('\r\n ');
}

function encodePhrase(text: string): string {
  return /[^\u0020-\u007E]/.test(text) ? encodeRfc2047(text) : text;
}

function quotePhrase(name: string): string {
  return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function quotedName(name: string): string {
  return SPECIALS.test(name) ? quotePhrase(name) : name;
}

/** RFC 5322 mailbox. `encode` (default) uses encoded-words for non-ASCII; false quotes for a preview. */
export function formatMailbox(m: Mailbox, encode = true): string {
  if (!m.name) return m.address;
  const name = encode && /[^\u0020-\u007E]/.test(m.name) ? encodeRfc2047(m.name) : quotedName(m.name);
  return `${name} <${m.address}>`;
}

function optionalHeader(name: string, items: string[] | undefined): string[] {
  if (!items?.length) return [];
  const formatted = items.map((item) => formatMailbox(requireMailbox(item, name)));
  return [`${name}: ${formatted.join(FOLD)}`];
}

function optionalRaw(name: string, value: string | undefined, foldIds = false): string[] {
  if (!value) return [];
  rejectNl(value, name);
  const body = foldIds ? value.split(/\s+/).filter(Boolean).join(REF_FOLD) : value;
  return [`${name}: ${body}`];
}

/** Base64url of an RFC 5322 message (CRLF, body base64). Omits From / Date / Message-ID. */
export function buildMessage(input: MessageParts): string {
  const to = optionalHeader('To', input.to);
  if (to.length === 0) throw new InvalidInput('The to list is empty.');
  rejectNl(input.subject, 'subject');
  const lines = [
    ...to,
    ...optionalHeader('Cc', input.cc),
    ...optionalHeader('Bcc', input.bcc),
    `Subject: ${encodePhrase(input.subject)}`,
    ...optionalRaw('In-Reply-To', input.inReplyTo),
    ...optionalRaw('References', input.references, true),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(base64Std(utf8.encode(crlf(input.body)))),
  ];
  return b64urlEncode(utf8.encode(`${lines.join('\r\n')}\r\n`));
}
