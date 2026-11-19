/** Walk a Gmail MIME tree: body text (plain preferred, else HTML → markdown) and named attachments. */

import { htmlToMarkdown } from '../../html';
import { bytesOfBase64Url, decodeCharset, type GmailPart, header } from '../../mail/gmail';

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Text of a body part. Gmail usually hands body.data over already converted to UTF-8 although the part still declares
 * its original charset (verified live: a quoted-printable iso-2022-jp part arrived as UTF-8 bytes). Valid UTF-8 without
 * ESC (ISO-2022-JP's shift sequences are 7-bit, hence also valid UTF-8) is read as UTF-8; anything else by its label.
 */
function bodyText(bytes: Uint8Array, charset: string | null): string {
  if (!bytes.includes(0x1b)) {
    try {
      return UTF8.decode(bytes);
    } catch {
      // not UTF-8: Gmail passed the original bytes through
    }
  }
  return decodeCharset(bytes, charset);
}

export interface RawMailAttachment {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
}

interface MailBody {
  text: string;
  /** Set when the chosen text part was too large to inline (Gmail left only attachmentId). */
  note: string | null;
  attachments: RawMailAttachment[];
}

const LARGE_BODY_NOTE = 'Body is too large to fetch here; open the message in Gmail.';

function charsetOf(part: GmailPart): string | null {
  const ct = header(part, 'Content-Type');
  if (!ct) return null;
  const m = /charset\s*=\s*("?)([^";\s]+)\1/i.exec(ct);
  return m?.[2] ?? null;
}

function filenameOf(part: GmailPart): string {
  return (part.filename ?? '').trim();
}

function mimeOf(part: GmailPart): string {
  return (part.mimeType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

function decodeText(part: GmailPart): { text: string; large: boolean } {
  if (part.body?.data) {
    return { text: bodyText(bytesOfBase64Url(part.body.data), charsetOf(part)), large: false };
  }
  if (part.body?.attachmentId) return { text: '', large: true };
  return { text: '', large: false };
}

interface Acc {
  plain: string | null;
  html: string | null;
  plainLarge: boolean;
  htmlLarge: boolean;
  attachments: RawMailAttachment[];
  forwarded: { text: string; note: string | null } | null;
}

function takeAttachment(part: GmailPart, acc: Acc): void {
  const filename = filenameOf(part);
  const id = part.body?.attachmentId;
  if (!filename || !id) return;
  acc.attachments.push({
    filename,
    mimeType: part.mimeType ?? 'application/octet-stream',
    size: part.body?.size ?? 0,
    attachmentId: id,
  });
}

function joinPartText(prev: string | null, next: string): string {
  if (prev === null || prev === '') return next;
  if (next === '') return prev;
  return `${prev}\n\n${next}`;
}

function takeText(part: GmailPart, acc: Acc): void {
  const mime = mimeOf(part);
  const decoded = decodeText(part);
  if (mime === 'text/plain') {
    acc.plain = joinPartText(acc.plain, decoded.text);
    if (decoded.large) acc.plainLarge = true;
    return;
  }
  if (mime === 'text/html') {
    acc.html = joinPartText(acc.html, decoded.text);
    if (decoded.large) acc.htmlLarge = true;
  }
}

/** CID inlines (images and similar); never skip text/plain or text/html. */
function skipCidLeaf(part: GmailPart): boolean {
  const mime = mimeOf(part);
  if (mime === 'text/plain' || mime === 'text/html') return false;
  return Boolean(header(part, 'Content-ID'));
}

function emptyAcc(): Acc {
  return { plain: null, html: null, plainLarge: false, htmlLarge: false, attachments: [], forwarded: null };
}

/** Unnamed message/rfc822: keep its attachments; its text is only a fallback when the outer body is blank. */
function takeForwarded(part: GmailPart, acc: Acc): void {
  const inner = emptyAcc();
  for (const child of part.parts ?? []) walk(child, inner);
  acc.attachments.push(...inner.attachments);
  acc.forwarded ??= chosenText(inner);
}

function walk(part: GmailPart, acc: Acc): void {
  if (filenameOf(part)) {
    takeAttachment(part, acc);
    return;
  }
  if (mimeOf(part) === 'message/rfc822') {
    takeForwarded(part, acc);
    return;
  }
  if (part.parts?.length) {
    for (const child of part.parts) walk(child, acc);
    return;
  }
  if (skipCidLeaf(part)) return;
  takeText(part, acc);
}

function pickMain(acc: Acc): { text: string; note: string | null } {
  const plain = acc.plain;
  if (plain !== null && plain.trim() !== '') {
    return { text: plain, note: acc.plainLarge ? LARGE_BODY_NOTE : null };
  }
  if (acc.html === null) return { text: '', note: acc.plainLarge || acc.htmlLarge ? LARGE_BODY_NOTE : null };
  if (acc.htmlLarge) return { text: '', note: LARGE_BODY_NOTE };
  return { text: htmlToMarkdown(acc.html), note: null };
}

function chosenText(acc: Acc): { text: string; note: string | null } {
  const chosen = pickMain(acc);
  if (chosen.text.trim() !== '' || !acc.forwarded) return chosen;
  return { text: acc.forwarded.text, note: acc.forwarded.note ?? 'Forwarded message.' };
}

export function parseMailBody(payload: GmailPart | undefined): MailBody {
  const acc = emptyAcc();
  if (payload) walk(payload, acc);
  const { text, note } = chosenText(acc);
  return { text, note, attachments: acc.attachments };
}
