import { describe, expect, it } from 'vitest';
import { renderMail, renderMailSearch } from '../../src/core/mcp/render/mail';
import { getMailOut, searchMailOut } from '../../src/core/mcp/schemas/mail';
import type { ToolDef } from '../../src/core/mcp/tools/define';
import { mailReadTools } from '../../src/core/mcp/tools/mail';
import type { MailSearchResult, MailThread } from '../../src/core/services/mail/read';
import { AT_ISO, iso2022Message } from '../fixtures/mail/builder';
import { makeFakeContext } from '../helpers/fake-context';
import { makeFakeMail } from '../helpers/fake-mail';

const tool = (name: string): ToolDef => {
  const found = mailReadTools.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};

const search = tool('search_mail');
const read = tool('get_mail');

const searchSample: MailSearchResult = {
  messages: [
    {
      id: 'aaaaaaaa',
      threadId: 'tttttttt',
      date: AT_ISO,
      from: 'Taro Yamada <taro@akane.waseda.jp>',
      to: 'Hanako Yamada <hanako@akane.waseda.jp>',
      subject: '総合日本語３Ｘ',
      snippet: 'Please submit the report & slides',
      unread: true,
      hasAttachments: true,
      webUrl: 'https://mail.google.com/mail/?authuser=taro%40akane.waseda.jp#all/aaaaaaaa',
    },
  ],
  nextPageToken: 'p2',
  resultSizeEstimate: 3,
};

const threadSample: MailThread = {
  threadId: 'ff000004',
  subject: '総合日本語３Ｘ',
  webUrl: 'https://mail.google.com/mail/?authuser=taro%40akane.waseda.jp#all/ff000004',
  omitted: 1,
  messages: [
    {
      id: 'aa000004',
      date: AT_ISO,
      from: 'Taro Yamada <taro@akane.waseda.jp>',
      to: 'Hanako Yamada <hanako@akane.waseda.jp>',
      cc: 'Ken Sato <ken@akane.waseda.jp>',
      subject: '総合日本語３Ｘ',
      unread: true,
      text: 'see the attached 講義資料',
      truncated: false,
      note: null,
      attachments: [
        {
          filename: '講義資料.pdf',
          mimeType: 'application/pdf',
          size: 12_345,
          url: 'https://wasemoodle.example.com/f/tkt',
          note: null,
        },
      ],
    },
  ],
};

describe('mail tool definitions', () => {
  it('names, titles, read hints and model-facing descriptions', () => {
    expect(search.title).toBe('Search Waseda mail');
    expect(read.title).toBe('Read Waseda mail');
    expect(search.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, openWorldHint: true });
    expect(read.annotations).toMatchObject({ readOnlyHint: true });
    expect(search.description).toContain('list_messages');
    expect(search.description).toContain('in:inbox');
    expect(search.description.length).toBeGreaterThan(80);
    expect(read.description).toContain('does not mark the mail as read');
    expect(read.description).toContain('get_conversation');
    expect(read.description).toContain('thread_id from search_mail');
    expect(read.description).toContain('message_id from get_mail');
    expect(read.description.length).toBeGreaterThan(80);
  });

  it('validates search and get_mail input', () => {
    expect(search.input.safeParse({}).success).toBe(true);
    expect(search.input.safeParse({ query: 'from:hanako', limit: 10 }).success).toBe(true);
    expect(search.input.safeParse({ query: 'x'.repeat(501) }).success).toBe(false);
    expect(search.input.safeParse({ limit: 21 }).success).toBe(false);
    expect(search.input.safeParse({ page_token: 'p'.repeat(201) }).success).toBe(false);
    expect(read.input.safeParse({ message_id: 'aa000001' }).success).toBe(true);
    expect(read.input.safeParse({ thread_id: 'FF000001' }).success).toBe(true);
    expect(read.input.safeParse({ message_id: 'xyz' }).success).toBe(false);
    expect(read.input.safeParse({ message_id: 'abc' }).success).toBe(false);
  });
});

describe('mail renderers and output schemas', () => {
  it('renders a compact search listing and accepts the schema', () => {
    const text = renderMailSearch(searchSample);
    expect(text).toContain('1 message in Waseda mail');
    expect(text).toContain('[unread]');
    expect(text).toContain('総合日本語３Ｘ');
    expect(text).toContain('[attachment]');
    expect(text).toContain('thread_id tttttttt');
    expect(text).toContain('message_id aaaaaaaa');
    expect(text).toContain('using thread_id');
    expect(text).toContain('page_token p2');
    expect(searchMailOut.safeParse(searchSample).success).toBe(true);
    expect(searchMailOut.safeParse({ messages: 'nope' }).success).toBe(false);
    expect(renderMailSearch({ messages: [], nextPageToken: null, resultSizeEstimate: 0 })).toBe(
      'No matching Waseda mail.',
    );
  });

  it('renders a thread with header, body and attachment links', () => {
    const text = renderMail(threadSample);
    expect(text).toContain('# 総合日本語３Ｘ');
    expect(text).toContain('1 older omitted');
    expect(text).toContain('Taro Yamada <taro@akane.waseda.jp> → Hanako Yamada <hanako@akane.waseda.jp>');
    expect(text).toContain('see the attached 講義資料');
    expect(text).toContain('講義資料.pdf');
    expect(text).toContain('https://wasemoodle.example.com/f/tkt');
    expect(text).toContain('prepare_mail_reply');
    expect(text).toContain('message_id aa000004');
    expect(getMailOut.safeParse(threadSample).success).toBe(true);
    expect(getMailOut.safeParse({ threadId: 'x' }).success).toBe(false);
  });

  it('keeps a 12k body in the text render and names a service-level cut', () => {
    const body = 'x'.repeat(12_000);
    const first = threadSample.messages[0];
    if (!first) throw new Error('sample');
    const sample: MailThread = {
      ...threadSample,
      messages: [{ ...first, text: body, truncated: true, attachments: [] }],
    };
    const text = renderMail(sample);
    expect(text).toContain(body);
    expect(text).toContain('body cut at 12000 chars');
    expect(text).toContain('structured result');
    expect(text).toContain('open in Gmail');
  });
});

describe('mail tool run', () => {
  it('search_mail maps input and returns schema-valid data', async () => {
    const hit = {
      id: 'aaaaaaaa',
      threadId: 'aaaaaaaa',
      snippet: 'hi',
      internalDate: String(Date.parse(AT_ISO)),
      labelIds: ['INBOX'],
      payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: 'Hi' }] },
    };
    const mail = makeFakeMail({
      answers: {
        'GET messages': { messages: [{ id: 'aaaaaaaa', threadId: 'aaaaaaaa' }], resultSizeEstimate: 1 },
        'GET messages/aaaaaaaa': hit,
      },
    });
    const { ctx } = makeFakeContext({ mail });
    const args = search.input.parse({ query: 'is:unread', limit: 3 });
    const out = await search.run(ctx, args);
    expect(searchMailOut.safeParse(out.data).success).toBe(true);
    expect(out.text).toContain('get_mail');
    expect(mail.calls[0]?.query).toMatchObject({ q: 'is:unread', maxResults: 3 });
  });

  it('get_mail reads a message through the service', async () => {
    const mail = makeFakeMail({
      answers: {
        [`GET messages/${iso2022Message.id}`]: iso2022Message,
      },
    });
    const { ctx } = makeFakeContext({ mail });
    const out = await read.run(ctx, read.input.parse({ message_id: iso2022Message.id }));
    expect(getMailOut.safeParse(out.data).success).toBe(true);
    expect(out.text).toContain('課題です');
  });
});
