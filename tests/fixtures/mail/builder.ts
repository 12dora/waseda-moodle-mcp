/** Invented Gmail JSON (no real people). Bodies are base64url-encoded here. */

import type { GmailHeader, GmailMessage, GmailPart, GmailThread } from '../../../src/core/mail/gmail';

function b64urlBytes(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlUtf8(text: string): string {
  return b64urlBytes(new TextEncoder().encode(text));
}

export const AT_ISO = '2026-11-01T10:00:00+09:00';
export const AT_MS = String(Date.parse(AT_ISO));

export const ISO2022JP_TEXT = '課題です';
/** ISO-2022-JP bytes of ISO2022JP_TEXT. */
const ISO2022JP_B64URL = 'GyRCMl1CaiRHJDkbKEI';

const FROM = 'Taro Yamada <taro@akane.waseda.jp>';
const TO = 'Hanako Yamada <hanako@akane.waseda.jp>';
const SUBJECT = '総合日本語３Ｘ';

function hdrs(pairs: Array<[string, string]>): GmailHeader[] {
  return pairs.map(([name, value]) => ({ name, value }));
}

function textPart(opts: {
  mime: string;
  text?: string;
  charset?: string;
  data?: string;
  filename?: string;
  attachmentId?: string;
  size?: number;
  contentId?: string;
}): GmailPart {
  const charset = opts.charset ?? 'utf-8';
  const headers = hdrs([['Content-Type', `${opts.mime}; charset=${charset}`]]);
  if (opts.contentId) headers.push({ name: 'Content-ID', value: opts.contentId });
  const body: NonNullable<GmailPart['body']> = {};
  if (opts.attachmentId) {
    body.attachmentId = opts.attachmentId;
    body.size = opts.size ?? 0;
  } else if (opts.data !== undefined) {
    body.data = opts.data;
    body.size = opts.size;
  } else if (opts.text !== undefined) {
    body.data = b64urlUtf8(opts.text);
  }
  return { mimeType: opts.mime, filename: opts.filename, headers, body };
}

interface MessageOpts {
  id: string;
  threadId?: string;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  snippet?: string;
  unread?: boolean;
  internalDate?: string;
  mimeType?: string;
  parts?: GmailPart[];
  body?: GmailPart['body'];
  extraHeaders?: GmailHeader[];
}

export function gmailMessage(opts: MessageOpts): GmailMessage {
  const headers = hdrs([
    ['From', opts.from ?? FROM],
    ['To', opts.to ?? TO],
    ['Subject', opts.subject ?? SUBJECT],
    ['Date', 'Sun, 1 Nov 2026 10:00:00 +0900'],
  ]);
  if (opts.cc) headers.push({ name: 'Cc', value: opts.cc });
  if (opts.extraHeaders) headers.push(...opts.extraHeaders);
  return {
    id: opts.id,
    threadId: opts.threadId ?? opts.id,
    snippet: opts.snippet ?? '',
    internalDate: opts.internalDate ?? AT_MS,
    labelIds: opts.unread === false ? ['INBOX'] : ['UNREAD', 'INBOX'],
    payload: { mimeType: opts.mimeType ?? 'text/plain', headers, body: opts.body, parts: opts.parts },
  };
}

export function gmailThread(id: string, messages: GmailMessage[]): GmailThread {
  return { id, messages: messages.map((m) => ({ ...m, threadId: id })) };
}

export const iso2022Message = gmailMessage({
  id: 'aa000001',
  threadId: 'ff000001',
  extraHeaders: [{ name: 'Content-Type', value: 'text/plain; charset=ISO-2022-JP' }],
  body: { data: ISO2022JP_B64URL },
});

export const htmlOnlyMessage = gmailMessage({
  id: 'aa000002',
  threadId: 'ff000002',
  mimeType: 'text/html',
  extraHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
  body: { data: b64urlUtf8('<p>Please submit the <strong>report</strong> by Friday.</p>') },
});

export const alternativeMessage = gmailMessage({
  id: 'aa000003',
  threadId: 'ff000003',
  mimeType: 'multipart/alternative',
  parts: [
    textPart({ mime: 'text/plain', text: 'plain body of 総合日本語３Ｘ' }),
    textPart({ mime: 'text/html', text: '<p>html body of 総合日本語３Ｘ</p>' }),
  ],
});

export const mixedMessage = gmailMessage({
  id: 'aa000004',
  threadId: 'ff000004',
  cc: 'Ken Sato <ken@akane.waseda.jp>',
  mimeType: 'multipart/mixed',
  parts: [
    {
      mimeType: 'multipart/alternative',
      parts: [
        textPart({ mime: 'text/plain', text: 'see the attached 講義資料' }),
        textPart({ mime: 'text/html', text: '<p>see the attached 講義資料</p>' }),
      ],
    },
    textPart({ mime: 'application/pdf', filename: '講義資料.pdf', attachmentId: 'ANGjd-attach-1', size: 12_345 }),
    textPart({
      mime: 'image/png',
      contentId: '<img001@akane.waseda.jp>',
      attachmentId: 'ANGjd-inline-1',
      size: 200,
    }),
  ],
});

export function largeAttachmentMessage(size: number): GmailMessage {
  return gmailMessage({
    id: 'aa000005',
    threadId: 'ff000005',
    mimeType: 'multipart/mixed',
    parts: [
      textPart({ mime: 'text/plain', text: 'recording attached' }),
      textPart({ mime: 'application/zip', filename: 'recordings.zip', attachmentId: 'ANGjd-big', size }),
    ],
  });
}

export const largeBodyMessage = gmailMessage({
  id: 'aa000006',
  threadId: 'ff000006',
  extraHeaders: [{ name: 'Content-Type', value: 'text/plain; charset=utf-8' }],
  body: { attachmentId: 'ANGjd-huge-body', size: 2_000_000 },
});

export function longTextMessage(id: string, chars: number, at = AT_MS): GmailMessage {
  return gmailMessage({
    id,
    threadId: 'ff00000a',
    internalDate: at,
    extraHeaders: [{ name: 'Content-Type', value: 'text/plain; charset=utf-8' }],
    body: { data: b64urlUtf8('x'.repeat(chars)) },
  });
}

export function searchMeta(opts: {
  id: string;
  threadId?: string;
  mixed?: boolean;
  unread?: boolean;
  snippet?: string;
}): GmailMessage {
  return gmailMessage({
    id: opts.id,
    threadId: opts.threadId ?? opts.id,
    unread: opts.unread,
    snippet: opts.snippet ?? 'Please submit the report &amp; slides',
    mimeType: opts.mixed ? 'multipart/mixed' : 'text/plain',
  });
}
