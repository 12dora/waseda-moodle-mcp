import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Forbidden,
  InvalidInput,
  MailNeedsReconnect,
  MailUnavailable,
  NeedsReconnect,
  NotFound,
} from '../../src/core/errors';
import { bytesOfBase64Url, type GmailMessage, gmailWebUrl } from '../../src/core/mail/gmail';
import { mailWriteTools } from '../../src/core/mcp/tools/mail-write';
import { confirmAction, prepareMailReply, prepareMailSend } from '../../src/core/services/actions';
import { UNCERTAIN_MARK } from '../../src/core/services/actions/target';
import type { Scope } from '../../src/core/types';
import { makeFakeContext } from '../helpers/fake-context';
import { type FakeMailOptions, makeFakeMail } from '../helpers/fake-mail';

const WRITE: Scope[] = ['moodle:read', 'moodle:write'];
const NOW = new Date('2026-10-14T03:00:00Z');
const MSG_ID = 'a1b2c3d4e5f67890';
const THREAD_ID = 'b2c3d4e5f6789012';
const SENT_ID = 'c3d4e5f678901234';
const SELF = 'taro@akane.waseda.jp';

beforeEach(() => {
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

function meta(id: string, threadId: string, headers: Record<string, string>): GmailMessage {
  return {
    id,
    threadId,
    payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) },
  };
}

function withMail(opts: FakeMailOptions = {}) {
  const mail = makeFakeMail(opts);
  const fake = makeFakeContext({ mail, scopes: WRITE });
  return { ...fake, mail };
}

const SEND = {
  to: ['Hanako Suzuki <hanako@akane.waseda.jp>'],
  subject: 'Hello',
  body: 'See you at the seminar.',
};

function rfc822(raw: string): string {
  return new TextDecoder().decode(bytesOfBase64Url(raw));
}

describe('mailWriteTools', () => {
  it('exports the two prepare tools', () => {
    expect(mailWriteTools.map((t) => t.name)).toEqual(['prepare_mail_send', 'prepare_mail_reply']);
    expect(mailWriteTools[1]?.description).toContain('message_id from search_mail / get_mail');
  });
});

describe('prepareMailSend', () => {
  it('stores a pending preview with From/To/Subject/Body and a recall warning', async () => {
    const { ctx } = withMail();
    const p = await prepareMailSend(ctx, SEND);
    expect(p.kind).toBe('mail_send');
    expect(p.title).toBe('Send mail to 1 recipient');
    expect(p.details).toEqual([
      `From: ${SELF}`,
      'To: Hanako Suzuki <hanako@akane.waseda.jp>',
      'Subject: Hello',
      'Body: See you at the seminar.',
    ]);
    expect(p.warnings).toContain('Sent mail cannot be recalled.');
    expect((await ctx.store.getAction(p.actionId))!.payload).toMatchObject({ from: SELF });
  });

  it('names extra recipients, shows Cc/Bcc only when set, and rejects bad input', async () => {
    const { ctx } = withMail();
    const p = await prepareMailSend(ctx, {
      to: ['hanako@akane.waseda.jp', 'ken@akane.waseda.jp'],
      cc: ['seminar@akane.waseda.jp'],
      bcc: ['secret@akane.waseda.jp'],
      subject: 'Hello',
      body: 'Hi',
    });
    expect(p.title).toBe('Send mail to 4 recipients');
    expect(p.details).toContain('Cc: seminar@akane.waseda.jp');
    expect(p.details).toContain('Bcc: secret@akane.waseda.jp');
    await expect(prepareMailSend(ctx, { ...SEND, to: ['  '] })).rejects.toThrow(InvalidInput);
    await expect(prepareMailSend(ctx, { ...SEND, to: ['not-an-email'] })).rejects.toThrow(InvalidInput);
    await expect(prepareMailSend(ctx, { ...SEND, subject: 'Hi\r\nBcc: evil@x.jp' })).rejects.toThrow(InvalidInput);
    const tooMany = Array.from({ length: 21 }, (_, i) => `u${i}@akane.waseda.jp`);
    await expect(prepareMailSend(ctx, { ...SEND, to: tooMany })).rejects.toThrow(InvalidInput);
  });

  it('rejects a read-only connection and a missing mail connection', async () => {
    const mail = makeFakeMail();
    const ro = makeFakeContext({ mail, scopes: ['moodle:read'] });
    await expect(prepareMailSend(ro.ctx, SEND)).rejects.toBeInstanceOf(Forbidden);
    const none = makeFakeContext({ scopes: WRITE });
    await expect(prepareMailSend(none.ctx, SEND)).rejects.toBeInstanceOf(NotFound);
    const locked = withMail({ canSend: false });
    await expect(prepareMailSend(locked.ctx, SEND)).rejects.toBeInstanceOf(Forbidden);
  });

  it('audits a title without addresses or subject', async () => {
    const { ctx, state } = withMail();
    await prepareMailSend(ctx, SEND);
    const blob = JSON.stringify(state.audit.map((a) => a.detail));
    expect(blob).not.toContain('hanako@');
    expect(state.audit[0]?.detail).toMatchObject({ title: 'Send mail to 1 recipient' });
  });
});

describe('prepareMailReply', () => {
  const headers = {
    From: 'Alice <alice@example.com>',
    To: 'Taro Yamada <taro@akane.waseda.jp>, Ken Sato <ken@akane.waseda.jp>',
    Cc: 'Seminar <seminar@akane.waseda.jp>',
    Subject: 'Homework',
    'Message-ID': '<m1@akane.waseda.jp>',
    References: '<m0@akane.waseda.jp>',
  };

  function replyMail(extra: Record<string, string> = {}) {
    return withMail({
      answers: { [`GET messages/${MSG_ID}`]: meta(MSG_ID, THREAD_ID, { ...headers, ...extra }) },
    });
  }

  it('replies to Reply-To (or From), prefixes Re:, and appends Message-ID to References', async () => {
    const { ctx, mail } = replyMail({ 'Reply-To': 'replies@example.com' });
    const p = await prepareMailReply(ctx, { messageId: MSG_ID, body: 'Thanks.' });
    expect(p.kind).toBe('mail_reply');
    expect(p.title).toBe('Reply to mail (1 recipient)');
    expect(p.details).toContain('To: replies@example.com');
    expect(p.details).toContain('Subject: Re: Homework');
    expect(p.details.some((d) => d.startsWith('Cc:'))).toBe(false);
    expect(mail.calls[0]).toEqual({
      method: 'GET',
      path: `messages/${MSG_ID}`,
      query: {
        format: 'metadata',
        metadataHeaders: ['From', 'Reply-To', 'To', 'Cc', 'Subject', 'Message-ID', 'References'],
      },
    });
    const row = (await ctx.store.getAction(p.actionId))!;
    expect(row.payload).toMatchObject({
      from: SELF,
      messageId: MSG_ID,
      threadId: THREAD_ID,
      inReplyTo: '<m1@akane.waseda.jp>',
      references: '<m0@akane.waseda.jp> <m1@akane.waseda.jp>',
    });
  });

  it('reply_all adds original To and Cc minus the user, appends extra cc, and keeps an existing Re: subject', async () => {
    const { ctx } = replyMail({ Subject: 'Re: Homework' });
    const p = await prepareMailReply(ctx, {
      messageId: MSG_ID,
      body: 'Thanks.',
      replyAll: true,
      cc: ['hanako@akane.waseda.jp'],
    });
    expect(p.title).toBe('Reply to mail (4 recipients)');
    expect(p.details).toContain('To: Alice <alice@example.com>, Ken Sato <ken@akane.waseda.jp>');
    expect(p.details).toContain('Cc: Seminar <seminar@akane.waseda.jp>, hanako@akane.waseda.jp');
    expect(p.details).toContain('Subject: Re: Homework');
  });

  it('keeps 回复/返信/Aw subjects, caps References to the last 20 ids, and decodes encoded From', async () => {
    const old = Array.from({ length: 20 }, (_, i) => `<id${i}@x.jp>`).join(' ');
    const { ctx } = replyMail({
      From: '=?UTF-8?B?5bGx55Sw5aSq6YOO?= <hanako@akane.waseda.jp>',
      To: SELF,
      Subject: '返信：テスト',
      References: old,
      'Message-ID': '<new@x.jp>',
    });
    const p = await prepareMailReply(ctx, { messageId: MSG_ID, body: 'ok' });
    expect(p.details).toContain('To: 山田太郎 <hanako@akane.waseda.jp>');
    expect(p.details).toContain('Subject: 返信：テスト');
    const refs = ((await ctx.store.getAction(p.actionId))!.payload as { references: string }).references;
    expect(refs.startsWith('<id0@x.jp>')).toBe(false);
    expect(refs.split(' ')).toHaveLength(20);
    expect(refs.endsWith('<new@x.jp>')).toBe(true);
  });

  it('rejects a bad message_id and a missing mail', async () => {
    const { ctx } = withMail();
    await expect(prepareMailReply(ctx, { messageId: 'nope', body: 'x' })).rejects.toThrow(InvalidInput);
    const missing = withMail({ answers: {} });
    await expect(prepareMailReply(missing.ctx, { messageId: MSG_ID, body: 'x' })).rejects.toBeInstanceOf(NotFound);
  });

  it('parses raw address headers: groups, comments, encoded commas, then drops junk', async () => {
    const { ctx } = replyMail({
      From: '=?UTF-8?B?WWFtYWRhLCBUYXJv?= <hanako@akane.waseda.jp> (staff)',
      To: 'undisclosed-recipients:;',
      Cc: 'Team: ken@akane.waseda.jp, not-an-email;',
      Subject: '=?UTF-8?Q?Hello=0AWorld?=',
    });
    const p = await prepareMailReply(ctx, { messageId: MSG_ID, body: 'Thanks.', replyAll: true });
    expect(p.title).toBe('Reply to mail (2 recipients)');
    expect(p.details).toContain('To: "Yamada, Taro" <hanako@akane.waseda.jp>');
    expect(p.details).toContain('Cc: ken@akane.waseda.jp');
    expect(p.details).toContain('Subject: Re: Hello World');
  });

  it('fails with No recipients only when every parsed address was dropped', async () => {
    const { ctx } = replyMail({ From: 'undisclosed-recipients:;', To: SELF, Cc: '', Subject: 'Hi' });
    await expect(prepareMailReply(ctx, { messageId: MSG_ID, body: 'x' })).rejects.toThrow('No recipients to reply to.');
  });

  it('quotes display names that contain specials or @ in the preview', async () => {
    const { ctx } = replyMail({
      From: '"Info, evil@example.com," <hanako@akane.waseda.jp>',
      To: SELF,
      Subject: 'Hi',
    });
    const p = await prepareMailReply(ctx, { messageId: MSG_ID, body: 'x' });
    expect(p.details).toContain('To: "Info, evil@example.com," <hanako@akane.waseda.jp>');
    expect(p.details).not.toContain('To: Info, evil@example.com, <hanako@akane.waseda.jp>');
  });

  it('replies to a sent message by using the original To (and Cc on reply_all)', async () => {
    const { ctx } = replyMail({
      From: `Taro Yamada <${SELF}>`,
      To: 'Hanako Suzuki <hanako@akane.waseda.jp>',
      Cc: 'Ken Sato <ken@akane.waseda.jp>',
      Subject: 'Hello',
    });
    const one = await prepareMailReply(ctx, { messageId: MSG_ID, body: 'following up' });
    expect(one.details).toContain('To: Hanako Suzuki <hanako@akane.waseda.jp>');
    expect(one.details.some((d) => d.startsWith('Cc:'))).toBe(false);

    const all = await prepareMailReply(ctx, { messageId: MSG_ID, body: 'following up', replyAll: true });
    expect(all.details).toContain('To: Hanako Suzuki <hanako@akane.waseda.jp>');
    expect(all.details).toContain('Cc: Ken Sato <ken@akane.waseda.jp>');
  });
});

describe('confirm mail send/reply', () => {
  it('posts raw (no threadId) for mail_send and returns the Gmail URL', async () => {
    const { ctx, mail } = withMail({ answers: { 'POST messages/send': { id: SENT_ID, threadId: THREAD_ID } } });
    const p = await prepareMailSend(ctx, SEND);
    const r = await confirmAction(ctx, p.actionId, 'mcp');
    expect(r).toMatchObject({ status: 'executed', message: 'Mail sent.', url: gmailWebUrl(SELF, SENT_ID) });
    const post = mail.calls.find((c) => c.method === 'POST');
    expect(post).toMatchObject({ path: 'messages/send' });
    const body = post?.body as { raw: string; threadId?: string };
    expect(rfc822(body.raw)).toContain('To: Hanako Suzuki <hanako@akane.waseda.jp>');
    expect(body.threadId).toBeUndefined();
  });

  it('posts raw and threadId for mail_reply', async () => {
    const { ctx, mail } = withMail({
      answers: {
        [`GET messages/${MSG_ID}`]: meta(MSG_ID, THREAD_ID, {
          From: 'alice@example.com',
          Subject: 'Hi',
          'Message-ID': '<m1@x.jp>',
        }),
        'POST messages/send': { id: SENT_ID, threadId: THREAD_ID },
      },
    });
    const p = await prepareMailReply(ctx, { messageId: MSG_ID, body: 'Thanks.' });
    const r = await confirmAction(ctx, p.actionId, 'mcp');
    expect(r.status).toBe('executed');
    expect(mail.calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      raw: expect.any(String),
      threadId: THREAD_ID,
    });
  });

  it('fails MailUnavailable with Check Sent mail and the uncertain mark', async () => {
    const { ctx } = withMail({
      answers: {
        'POST messages/send': () => {
          throw new MailUnavailable();
        },
      },
    });
    const p = await prepareMailSend(ctx, SEND);
    const r = await confirmAction(ctx, p.actionId, 'mcp');
    expect(r.status).toBe('failed');
    expect(r.message).toContain('Check Sent mail');
    expect(r.message).toContain(UNCERTAIN_MARK);
  });

  it('hands a NeedsReconnect send back to pending', async () => {
    const { ctx, state } = withMail({
      answers: {
        'POST messages/send': () => {
          throw new NeedsReconnect();
        },
      },
    });
    const p = await prepareMailSend(ctx, SEND);
    await expect(confirmAction(ctx, p.actionId, 'mcp')).rejects.toBeInstanceOf(NeedsReconnect);
    expect(state.actions.get(p.actionId)?.status).toBe('pending');
  });

  it('settles a stale executing mail action with Check Sent mail', async () => {
    const { ctx, store } = withMail({ answers: { 'POST messages/send': { id: SENT_ID } } });
    const p = await prepareMailSend(ctx, SEND);
    expect(await store.claimAction(p.actionId, ctx.user.id, NOW.getTime())).toBe(true);
    vi.setSystemTime(new Date(NOW.getTime() + 60 * 60_000));
    const r = await confirmAction(ctx, p.actionId, 'mcp');
    expect(r.status).toBe('failed');
    expect(r.message).toContain('Check Sent mail');
    expect(r.message).toContain(UNCERTAIN_MARK);
  });

  it('fails MailUnavailable maybeSent false without the uncertain mark and does not supersede', async () => {
    const { ctx, state } = withMail({
      answers: {
        [`GET messages/${MSG_ID}`]: meta(MSG_ID, THREAD_ID, {
          From: 'alice@example.com',
          Subject: 'Hi',
          'Message-ID': '<m1@x.jp>',
        }),
      },
    });
    const a = await prepareMailReply(ctx, { messageId: MSG_ID, body: 'one' });
    const b = await prepareMailReply(ctx, { messageId: MSG_ID, body: 'two' });
    ctx.mail = async () => {
      throw new MailUnavailable('down', { maybeSent: false });
    };
    const r = await confirmAction(ctx, a.actionId, 'mcp');
    expect(r.status).toBe('failed');
    expect(r.message).not.toContain(UNCERTAIN_MARK);
    expect(state.actions.get(b.actionId)?.status).toBe('pending');
  });

  it('hands NotFound from requireMail and MailNeedsReconnect back to pending', async () => {
    const { ctx, state } = withMail({ answers: { 'POST messages/send': { id: SENT_ID } } });
    const missing = await prepareMailSend(ctx, SEND);
    ctx.mail = undefined;
    await expect(confirmAction(ctx, missing.actionId, 'mcp')).rejects.toBeInstanceOf(NotFound);
    expect(state.actions.get(missing.actionId)?.status).toBe('pending');

    const { ctx: ctx2, state: state2 } = withMail({ answers: { 'POST messages/send': { id: SENT_ID } } });
    const reconnect = await prepareMailSend(ctx2, SEND);
    ctx2.mail = async () => {
      throw new MailNeedsReconnect('The Waseda mail connection has expired.');
    };
    await expect(confirmAction(ctx2, reconnect.actionId, 'mcp')).rejects.toBeInstanceOf(MailNeedsReconnect);
    expect(state2.actions.get(reconnect.actionId)?.status).toBe('pending');
  });

  it('fails a Gmail 404 from send as a definite failure (deleted thread)', async () => {
    const { ctx, state } = withMail({
      answers: {
        [`GET messages/${MSG_ID}`]: meta(MSG_ID, THREAD_ID, {
          From: 'alice@example.com',
          Subject: 'Hi',
          'Message-ID': '<m1@x.jp>',
        }),
        'POST messages/send': () => {
          throw new NotFound('Mail not found.');
        },
      },
    });
    const p = await prepareMailReply(ctx, { messageId: MSG_ID, body: 'Thanks.' });
    const r = await confirmAction(ctx, p.actionId, 'mcp');
    expect(r.status).toBe('failed');
    expect(r.message).toBe('Mail not found.');
    expect(r.message).not.toContain(UNCERTAIN_MARK);
    expect(state.actions.get(p.actionId)?.status).toBe('failed');
  });

  it('fails when the connected mailbox changed since prepare', async () => {
    const { ctx } = withMail({ answers: { 'POST messages/send': { id: SENT_ID } } });
    const p = await prepareMailSend(ctx, SEND);
    ctx.mail = async () =>
      makeFakeMail({ address: 'ken@akane.waseda.jp', answers: { 'POST messages/send': { id: SENT_ID } } });
    const r = await confirmAction(ctx, p.actionId, 'mcp');
    expect(r.status).toBe('failed');
    expect(r.message).toBe('The connected mailbox changed since this mail was prepared. Prepare it again.');
    expect(r.message).not.toContain(UNCERTAIN_MARK);
  });

  it('does not audit Gmail error text that may contain a recipient address', async () => {
    const { ctx, state } = withMail({
      answers: {
        'POST messages/send': () => {
          throw new InvalidInput('Recipient hanako@akane.waseda.jp rejected');
        },
      },
    });
    const p = await prepareMailSend(ctx, SEND);
    const r = await confirmAction(ctx, p.actionId, 'mcp');
    expect(r.status).toBe('failed');
    expect(r.message).toContain('hanako@');
    const blob = JSON.stringify(state.audit.map((a) => a.detail));
    expect(blob).not.toContain('hanako@');
  });
});
