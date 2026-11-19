import { describe, expect, it } from 'vitest';
import { InvalidInput, NotFound } from '../../src/core/errors';
import { decodeCharset, gmailWebUrl } from '../../src/core/mail/gmail';
import { getMail, MAIL_ATTACHMENT_MAX_BYTES, searchMail } from '../../src/core/services/mail/read';
import {
  AT_ISO,
  AT_MS,
  alternativeMessage,
  b64urlUtf8,
  gmailMessage,
  gmailThread,
  htmlOnlyMessage,
  ISO2022JP_TEXT,
  iso2022Message,
  largeAttachmentMessage,
  largeBodyMessage,
  longTextMessage,
  mixedMessage,
  searchMeta,
} from '../fixtures/mail/builder';
import { makeFakeContext } from '../helpers/fake-context';
import { type FakeMail, type FakeMailOptions, makeFakeMail } from '../helpers/fake-mail';

const ADDR = 'taro@akane.waseda.jp';
const HEX12 = Array.from({ length: 12 }, (_, i) => `a000000${i.toString(16)}`);

function ctxOf(mail?: FakeMail) {
  return makeFakeContext(mail ? { mail } : {}).ctx;
}

describe('searchMail', () => {
  it('defaults to in:inbox, maps metadata, decodes snippet entities and pages', async () => {
    const first = searchMeta({ id: 'aaaaaaaa', mixed: true, snippet: 'Please submit the report &amp; slides' });
    const second = searchMeta({ id: 'bbbbbbbb', unread: false, snippet: 'ok' });
    const mail = makeFakeMail({
      answers: {
        'GET messages': ({ query }) => {
          if (query?.pageToken === 'p2') {
            return { messages: [{ id: second.id, threadId: second.threadId }], resultSizeEstimate: 2 };
          }
          return {
            messages: [{ id: first.id, threadId: first.threadId }],
            nextPageToken: 'p2',
            resultSizeEstimate: 2,
          };
        },
        [`GET messages/${first.id}`]: first,
        [`GET messages/${second.id}`]: second,
      },
    });
    const ctx = ctxOf(mail);
    const page1 = await searchMail(ctx, {});
    expect(mail.calls[0]).toMatchObject({
      method: 'GET',
      path: 'messages',
      query: { q: 'in:inbox', maxResults: 10 },
    });
    expect(page1.nextPageToken).toBe('p2');
    expect(page1.resultSizeEstimate).toBe(2);
    expect(page1.messages[0]).toMatchObject({
      id: 'aaaaaaaa',
      date: AT_ISO,
      from: 'Taro Yamada <taro@akane.waseda.jp>',
      subject: '総合日本語３Ｘ',
      snippet: 'Please submit the report & slides',
      unread: true,
      hasAttachments: true,
      webUrl: gmailWebUrl(ADDR, 'aaaaaaaa'),
    });

    const page2 = await searchMail(ctx, { query: 'from:hanako', limit: 5, pageToken: 'p2' });
    expect(mail.calls.some((c) => c.path === 'messages' && c.query?.q === 'from:hanako')).toBe(true);
    expect(mail.calls.some((c) => c.path === 'messages' && c.query?.maxResults === 5)).toBe(true);
    expect(page2.messages[0]).toMatchObject({ id: 'bbbbbbbb', unread: false, hasAttachments: false });
    expect(page2.nextPageToken).toBeNull();
  });

  it('fetches metadata with concurrency at most 5', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const answers: NonNullable<FakeMailOptions['answers']> = {
      'GET messages': { messages: HEX12.map((id) => ({ id, threadId: id })), resultSizeEstimate: 12 },
    };
    for (const id of HEX12) {
      answers[`GET messages/${id}`] = async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return searchMeta({ id });
      };
    }
    const mail = makeFakeMail({ answers });
    const r = await searchMail(ctxOf(mail), { limit: 20 });
    expect(r.messages).toHaveLength(12);
    expect(maxInFlight).toBeLessThanOrEqual(5);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(mail.calls).toHaveLength(13);
  });

  it('returns an empty list when Gmail has no matches', async () => {
    const mail = makeFakeMail({ answers: { 'GET messages': { resultSizeEstimate: 0 } } });
    const r = await searchMail(ctxOf(mail), { query: 'subject:zzz' });
    expect(r).toEqual({ messages: [], nextPageToken: null, resultSizeEstimate: 0 });
  });

  it('throws NotFound when the user has no mail connection', async () => {
    await expect(searchMail(ctxOf(), {})).rejects.toBeInstanceOf(NotFound);
  });

  it('skips a message that 404s between list and metadata', async () => {
    const first = searchMeta({ id: 'aaaaaaaa' });
    const third = searchMeta({ id: 'cccccccc' });
    const mail = makeFakeMail({
      answers: {
        'GET messages': {
          messages: [{ id: 'aaaaaaaa' }, { id: 'bbbbbbbb' }, { id: 'cccccccc' }],
          resultSizeEstimate: 3,
        },
        'GET messages/aaaaaaaa': first,
        'GET messages/bbbbbbbb': () => {
          throw new NotFound('Mail not found.');
        },
        'GET messages/cccccccc': third,
      },
    });
    const r = await searchMail(ctxOf(mail), {});
    expect(r.messages.map((m) => m.id)).toEqual(['aaaaaaaa', 'cccccccc']);
    expect(r.resultSizeEstimate).toBe(3);
  });
});

describe('getMail', () => {
  it('decodes an ISO-2022-JP plain part', async () => {
    const mail = makeFakeMail({ answers: { [`GET messages/${iso2022Message.id}`]: iso2022Message } });
    const r = await getMail(ctxOf(mail), { messageId: iso2022Message.id });
    expect(r.messages[0]?.text).toBe(ISO2022JP_TEXT);
    expect(r.omitted).toBe(0);
    expect(r.webUrl).toBe(gmailWebUrl(ADDR, iso2022Message.threadId));
  });

  it('converts an HTML-only part to markdown', async () => {
    const mail = makeFakeMail({ answers: { [`GET messages/${htmlOnlyMessage.id}`]: htmlOnlyMessage } });
    const r = await getMail(ctxOf(mail), { messageId: htmlOnlyMessage.id });
    expect(r.messages[0]?.text).toContain('report');
    expect(r.messages[0]?.text).not.toContain('<p>');
    expect(r.messages[0]?.text).not.toContain('<strong>');
  });

  it('prefers text/plain in multipart/alternative', async () => {
    const mail = makeFakeMail({ answers: { [`GET messages/${alternativeMessage.id}`]: alternativeMessage } });
    const r = await getMail(ctxOf(mail), { messageId: alternativeMessage.id });
    expect(r.messages[0]?.text).toBe('plain body of 総合日本語３Ｘ');
    expect(r.messages[0]?.text).not.toContain('html body');
  });

  it('walks nested multipart/mixed, signs a download ticket and skips CID inline parts', async () => {
    const mail = makeFakeMail({ answers: { [`GET messages/${mixedMessage.id}`]: mixedMessage } });
    const { ctx } = makeFakeContext({ mail });
    const r = await getMail(ctx, { messageId: mixedMessage.id });
    expect(r.messages[0]?.text).toBe('see the attached 講義資料');
    expect(r.messages[0]?.cc).toContain('ken@akane.waseda.jp');
    expect(r.messages[0]?.attachments).toHaveLength(1);
    const att = r.messages[0]?.attachments[0];
    expect(att).toMatchObject({ filename: '講義資料.pdf', mimeType: 'application/pdf', size: 12_345, note: null });
    expect(att?.url).toMatch(/^https:\/\/wasemoodle\.example\.com\/f\//);
    const ticket = att?.url?.split('/').pop() ?? '';
    await expect(ctx.signer.verify(ticket)).resolves.toMatchObject({
      k: 'ml',
      u: ctx.user.id,
      m: mixedMessage.id,
      a: 'ANGjd-attach-1',
      n: '講義資料.pdf',
      t: 'application/pdf',
      s: 12_345,
    });
  });

  it('sets url null and a Gmail note when an attachment is over 5 MB', async () => {
    const msg = largeAttachmentMessage(MAIL_ATTACHMENT_MAX_BYTES + 1);
    const mail = makeFakeMail({ answers: { [`GET messages/${msg.id}`]: msg } });
    const r = await getMail(ctxOf(mail), { messageId: msg.id });
    expect(r.messages[0]?.attachments[0]).toMatchObject({
      filename: 'recordings.zip',
      url: null,
      note: 'Open it in Gmail.',
    });
  });

  it('notes a large body that Gmail only exposed as attachmentId', async () => {
    const mail = makeFakeMail({ answers: { [`GET messages/${largeBodyMessage.id}`]: largeBodyMessage } });
    const r = await getMail(ctxOf(mail), { messageId: largeBodyMessage.id });
    expect(r.messages[0]?.text).toBe('');
    expect(r.messages[0]?.note).toMatch(/too large/i);
  });

  it('keeps the newest 10 messages of a thread and names omitted', async () => {
    const messages = Array.from({ length: 12 }, (_, i) =>
      gmailMessage({
        id: `ab0000${i.toString(16).padStart(2, '0')}`,
        threadId: 'ff00000c',
        subject: i === 0 ? 'original subject' : 'Re: original subject',
        internalDate: String(Number(AT_MS) + i * 60_000),
        extraHeaders: [{ name: 'Content-Type', value: 'text/plain; charset=utf-8' }],
        body: { data: b64urlUtf8(`msg ${i}`) },
      }),
    );
    const thread = gmailThread('ff00000c', messages);
    const mail = makeFakeMail({ answers: { 'GET threads/ff00000c': thread } });
    const r = await getMail(ctxOf(mail), { threadId: 'ff00000c' });
    expect(r.omitted).toBe(2);
    expect(r.messages).toHaveLength(10);
    expect(r.subject).toBe('original subject');
    expect(r.messages[0]?.text).toBe('msg 2');
    expect(r.messages[9]?.text).toBe('msg 11');
  });

  it('caps per-message text and trims oldest messages to the call budget', async () => {
    const one = longTextMessage('aa100001', 13_000);
    const mailOne = makeFakeMail({ answers: { 'GET messages/aa100001': one } });
    const capped = await getMail(ctxOf(mailOne), { messageId: 'aa100001' });
    expect(capped.messages[0]?.truncated).toBe(true);
    expect(capped.messages[0]?.text).toHaveLength(12_000);

    const many = [0, 1, 2, 3].map((i) => longTextMessage(`aa20000${i}`, 12_000, String(Number(AT_MS) + i * 1000)));
    const mailMany = makeFakeMail({ answers: { 'GET threads/ff00000a': gmailThread('ff00000a', many) } });
    const trimmed = await getMail(ctxOf(mailMany), { threadId: 'ff00000a' });
    const total = trimmed.messages.reduce((n, m) => n + m.text.length, 0);
    expect(total).toBe(40_000);
    expect(trimmed.messages[0]?.text).toHaveLength(4_000);
    expect(trimmed.messages[0]?.truncated).toBe(true);
    expect(trimmed.messages[3]?.text).toHaveLength(12_000);
  });

  it('rejects invalid ids and NotFound when mail is not connected', async () => {
    const mail = makeFakeMail({ answers: { 'GET messages/aa000001': iso2022Message } });
    const ctx = ctxOf(mail);
    await expect(getMail(ctx, { messageId: 'xyz' })).rejects.toBeInstanceOf(InvalidInput);
    await expect(getMail(ctx, { threadId: 'gg' })).rejects.toBeInstanceOf(InvalidInput);
    await expect(getMail(ctx, {})).rejects.toThrow(/exactly one/);
    await expect(getMail(ctx, { messageId: 'aa000001', threadId: 'ff000001' })).rejects.toThrow(/exactly one/);
    await expect(getMail(ctxOf(), { messageId: 'aa000001' })).rejects.toBeInstanceOf(NotFound);
  });

  it('keeps text/html that carries Content-ID and still skips CID images', async () => {
    const msg = gmailMessage({
      id: 'aa000010',
      mimeType: 'multipart/related',
      parts: [
        {
          mimeType: 'text/html',
          headers: [
            { name: 'Content-Type', value: 'text/html; charset=utf-8' },
            { name: 'Content-ID', value: '<html@akane.waseda.jp>' },
          ],
          body: { data: b64urlUtf8('<p>newsletter body</p>') },
        },
        {
          mimeType: 'image/png',
          headers: [{ name: 'Content-ID', value: '<img@akane.waseda.jp>' }],
          body: { attachmentId: 'ANGjd-img', size: 10 },
        },
      ],
    });
    const mail = makeFakeMail({ answers: { [`GET messages/${msg.id}`]: msg } });
    const r = await getMail(ctxOf(mail), { messageId: msg.id });
    expect(r.messages[0]?.text).toContain('newsletter body');
    expect(r.messages[0]?.attachments).toEqual([]);
  });

  it('concatenates top-level text/plain parts of multipart/mixed', async () => {
    const msg = gmailMessage({
      id: 'aa000011',
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'text/plain',
          headers: [{ name: 'Content-Type', value: 'text/plain; charset=utf-8' }],
          body: { data: b64urlUtf8('first part') },
        },
        {
          mimeType: 'text/plain',
          headers: [{ name: 'Content-Type', value: 'text/plain; charset=utf-8' }],
          body: { data: b64urlUtf8('second part') },
        },
      ],
    });
    const mail = makeFakeMail({ answers: { [`GET messages/${msg.id}`]: msg } });
    const r = await getMail(ctxOf(mail), { messageId: msg.id });
    expect(r.messages[0]?.text).toBe('first part\n\nsecond part');
  });

  it('prefers html when the plain part is blank', async () => {
    const msg = gmailMessage({
      id: 'aa000012',
      mimeType: 'multipart/alternative',
      parts: [
        {
          mimeType: 'text/plain',
          headers: [{ name: 'Content-Type', value: 'text/plain; charset=utf-8' }],
          body: { data: b64urlUtf8('   ') },
        },
        {
          mimeType: 'text/html',
          headers: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
          body: { data: b64urlUtf8('<p>real html body</p>') },
        },
      ],
    });
    const mail = makeFakeMail({ answers: { [`GET messages/${msg.id}`]: msg } });
    const r = await getMail(ctxOf(mail), { messageId: msg.id });
    expect(r.messages[0]?.text).toContain('real html body');
    expect(r.messages[0]?.text).not.toContain('<p>');
  });

  it('does not let a forwarded message/rfc822 part beat the outer body', async () => {
    const msg = gmailMessage({
      id: 'aa000013',
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'text/html',
          headers: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
          body: { data: b64urlUtf8('<p>outer newsletter</p>') },
        },
        {
          mimeType: 'message/rfc822',
          parts: [
            {
              mimeType: 'text/plain',
              headers: [{ name: 'Content-Type', value: 'text/plain; charset=utf-8' }],
              body: { data: b64urlUtf8('forwarded plain') },
            },
          ],
        },
      ],
    });
    const mail = makeFakeMail({ answers: { [`GET messages/${msg.id}`]: msg } });
    const r = await getMail(ctxOf(mail), { messageId: msg.id });
    expect(r.messages[0]?.text).toContain('outer newsletter');
    expect(r.messages[0]?.text).not.toContain('forwarded plain');
    expect(r.messages[0]?.note).toBeNull();
  });

  it('uses the forwarded rfc822 text when the outer body is blank, with a short note', async () => {
    const msg = gmailMessage({
      id: 'aa000014',
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'text/plain',
          headers: [{ name: 'Content-Type', value: 'text/plain; charset=utf-8' }],
          body: { data: b64urlUtf8('   ') },
        },
        {
          mimeType: 'message/rfc822',
          parts: [
            {
              mimeType: 'text/plain',
              headers: [{ name: 'Content-Type', value: 'text/plain; charset=utf-8' }],
              body: { data: b64urlUtf8('forwarded plain') },
            },
          ],
        },
      ],
    });
    const mail = makeFakeMail({ answers: { [`GET messages/${msg.id}`]: msg } });
    const r = await getMail(ctxOf(mail), { messageId: msg.id });
    expect(r.messages[0]?.text).toBe('forwarded plain');
    expect(r.messages[0]?.note).toBe('Forwarded message.');
  });

  it('notes a forwarded rfc822 part even when that part has no text', async () => {
    const msg = gmailMessage({
      id: 'aa000015',
      mimeType: 'multipart/mixed',
      parts: [{ mimeType: 'message/rfc822', parts: [{ mimeType: 'application/octet-stream', body: { size: 1 } }] }],
    });
    const mail = makeFakeMail({ answers: { [`GET messages/${msg.id}`]: msg } });
    const r = await getMail(ctxOf(mail), { messageId: msg.id });
    expect(r.messages[0]?.text).toBe('');
    expect(r.messages[0]?.note).toBe('Forwarded message.');
  });
});

describe('decodeCharset aliases', () => {
  it('maps cp932 / ms932 / windows-31j / x-sjis to shift_jis', () => {
    const hiraganaA = Uint8Array.from([0x82, 0xa0]);
    for (const label of ['cp932', 'MS932', 'windows-31j', 'x-sjis']) {
      expect(decodeCharset(hiraganaA, label)).toBe('あ');
    }
  });
});
