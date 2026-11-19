import { describe, expect, it } from 'vitest';
import { InvalidInput } from '../../src/core/errors';
import { bytesOfBase64Url, decodeMimeWords } from '../../src/core/mail/gmail';
import { buildMessage, parseAddressList } from '../../src/core/mail/mime';

function rfc822(raw: string): string {
  return new TextDecoder().decode(bytesOfBase64Url(raw));
}

function unfolded(msg: string, name: string): string {
  const re = new RegExp(`(?:^|\\r\\n)${name}: ([^\\r\\n]*(?:\\r\\n[\\t ][^\\r\\n]*)*)`, 'i');
  const m = re.exec(msg);
  return m?.[1] ? m[1].replace(/\r\n[\t ]/g, ' ') : '';
}

function encodedWords(msg: string): string[] {
  return [...msg.matchAll(/=\?UTF-8\?B\?[^?]*\?=/g)].map((m) => m[0]);
}

describe('parseAddressList', () => {
  it('reads a bare address, a display name, and quoted names that contain commas', () => {
    expect(parseAddressList('alice@example.com')).toEqual([{ name: '', address: 'alice@example.com' }]);
    expect(parseAddressList('Alice <alice@example.com>')).toEqual([{ name: 'Alice', address: 'alice@example.com' }]);
    expect(parseAddressList('"Yamada, Taro" <taro@akane.waseda.jp>, Bob <bob@example.com>')).toEqual([
      { name: 'Yamada, Taro', address: 'taro@akane.waseda.jp' },
      { name: 'Bob', address: 'bob@example.com' },
    ]);
    expect(parseAddressList('<solo@example.com>')).toEqual([{ name: '', address: 'solo@example.com' }]);
  });

  it('expands group syntax, strips comments, and drops invalid mailboxes', () => {
    expect(parseAddressList('undisclosed-recipients:;')).toEqual([]);
    expect(parseAddressList('Team: a@x.jp, b@y.jp;')).toEqual([
      { name: '', address: 'a@x.jp' },
      { name: '', address: 'b@y.jp' },
    ]);
    expect(parseAddressList('a@x.jp (Taro), not-an-email, b@y.jp')).toEqual([
      { name: '', address: 'a@x.jp' },
      { name: '', address: 'b@y.jp' },
    ]);
    expect(parseAddressList('Alice <alice@example.com>, Team: ken@akane.waseda.jp;')).toEqual([
      { name: 'Alice', address: 'alice@example.com' },
      { name: '', address: 'ken@akane.waseda.jp' },
    ]);
  });

  it('keeps encoded-words whole so a comma inside the word is not a mailbox split', () => {
    const q = '=?UTF-8?Q?Yamada,_Taro?= <taro@akane.waseda.jp>';
    expect(parseAddressList(q)).toEqual([{ name: '=?UTF-8?Q?Yamada,_Taro?=', address: 'taro@akane.waseda.jp' }]);
    const b = '=?UTF-8?B?WWFtYWRhLCBUYXJv?= <taro@akane.waseda.jp>';
    expect(parseAddressList(b)).toEqual([{ name: '=?UTF-8?B?WWFtYWRhLCBUYXJv?=', address: 'taro@akane.waseda.jp' }]);
    const qParen = '=?UTF-8?Q?Team_(staff)?= <seminar@akane.waseda.jp>';
    expect(parseAddressList(qParen)).toEqual([
      { name: '=?UTF-8?Q?Team_(staff)?=', address: 'seminar@akane.waseda.jp' },
    ]);
  });
});

describe('buildMessage', () => {
  it('emits CRLF headers and a base64 body that round-trips', () => {
    const raw = buildMessage({ to: ['alice@example.com'], subject: 'Hi', body: 'Hello\nWorld' });
    const msg = rfc822(raw);
    expect(msg.includes('\n') && msg.replace(/\r\n/g, '').includes('\n')).toBe(false);
    expect(msg.replace(/\r\n/g, '').includes('\r')).toBe(false);
    expect(msg).toBe(
      'To: alice@example.com\r\n' +
        'Subject: Hi\r\n' +
        'MIME-Version: 1.0\r\n' +
        'Content-Type: text/plain; charset=UTF-8\r\n' +
        'Content-Transfer-Encoding: base64\r\n' +
        '\r\n' +
        'SGVsbG8NCldvcmxk\r\n',
    );
  });

  it('omits empty Cc/Bcc, includes Bcc when set, and quotes ASCII names with specials', () => {
    const msg = rfc822(
      buildMessage({
        to: ['Smith, John <john@example.com>'],
        cc: ['bob@example.com'],
        bcc: ['secret@example.com'],
        subject: 'Hi',
        body: 'x',
      }),
    );
    expect(unfolded(msg, 'To')).toBe('"Smith, John" <john@example.com>');
    expect(unfolded(msg, 'Cc')).toBe('bob@example.com');
    expect(unfolded(msg, 'Bcc')).toBe('secret@example.com');
    expect(rfc822(buildMessage({ to: ['a@b.jp'], subject: 'Hi', body: 'x' }))).not.toContain('Cc:');
  });

  it('encodes non-ASCII subject and display names as RFC 2047 words that decodeMimeWords restores', () => {
    const raw = buildMessage({
      to: ['山田太郎 <taro@akane.waseda.jp>'],
      subject: '課題の件',
      body: 'こんにちは',
    });
    const msg = rfc822(raw);
    expect(unfolded(msg, 'Subject')).toMatch(/^=\?UTF-8\?B\?/);
    expect(decodeMimeWords(unfolded(msg, 'Subject'))).toBe('課題の件');
    expect(decodeMimeWords(unfolded(msg, 'To'))).toBe('山田太郎 <taro@akane.waseda.jp>');
  });

  it('folds a long Japanese subject on UTF-8 character boundaries, each encoded-word ≤ 75', () => {
    const subject = 'あ'.repeat(40);
    const msg = rfc822(buildMessage({ to: ['taro@akane.waseda.jp'], subject, body: 'x' }));
    expect(msg).toMatch(/Subject: =\?UTF-8\?B\?.+\?=\r\n =\?UTF-8\?B\?/);
    expect(decodeMimeWords(unfolded(msg, 'Subject'))).toBe(subject);
    for (const word of encodedWords(msg)) expect(word.length).toBeLessThanOrEqual(75);
  });

  it('wraps a long base64 body at 76 and rejects CR/LF in header fields', () => {
    const msg = rfc822(buildMessage({ to: ['a@b.jp'], subject: 'Hi', body: 'a'.repeat(60) }));
    const body = msg.split('\r\n\r\n')[1] ?? '';
    const lines = body.replace(/\r\n$/, '').split('\r\n');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.length <= 76)).toBe(true);
    expect(() => buildMessage({ to: ['a@b.jp'], subject: 'Hi\r\nBcc: evil@x.jp', body: 'x' })).toThrow(InvalidInput);
    expect(() => buildMessage({ to: ['a@b.jp\nCc: evil@x.jp'], subject: 'Hi', body: 'x' })).toThrow(InvalidInput);
    expect(() =>
      buildMessage({ to: ['a@b.jp'], subject: 'Hi', body: 'x', inReplyTo: '<id@x.jp>\r\nBcc: evil@x.jp' }),
    ).toThrow(InvalidInput);
  });

  it('folds To/Cc/Bcc between mailboxes and References between ids, each line ≤ 998', () => {
    const to = Array.from({ length: 20 }, (_, i) => `user${i}@akane.waseda.jp`);
    const refs = Array.from({ length: 20 }, (_, i) => `<id${i}@akane.waseda.jp>`).join(' ');
    const msg = rfc822(
      buildMessage({
        to,
        cc: ['one@akane.waseda.jp', 'two@akane.waseda.jp'],
        bcc: ['secret@akane.waseda.jp', 'hidden@akane.waseda.jp'],
        subject: 'Hi',
        body: 'x',
        references: refs,
      }),
    );
    expect(msg).toContain('To: user0@akane.waseda.jp,\r\n user1@akane.waseda.jp');
    expect(msg).toContain('Cc: one@akane.waseda.jp,\r\n two@akane.waseda.jp');
    expect(msg).toContain('Bcc: secret@akane.waseda.jp,\r\n hidden@akane.waseda.jp');
    expect(msg).toContain('References: <id0@akane.waseda.jp>\r\n <id1@akane.waseda.jp>');
    const header = msg.split('\r\n\r\n')[0] ?? '';
    for (const line of header.split('\r\n')) expect(line.length).toBeLessThanOrEqual(998);
  });
});
