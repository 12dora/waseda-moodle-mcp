import { describe, expect, it } from 'vitest';
import type { MailConnection, MailInfo } from '../api/types';
import { canReconnectMail, isoOfMs, mailResultNotice, mailView, withoutMailParam } from './mail';

const connection = (over: Partial<MailConnection> = {}): MailConnection => ({
  address: 'taro@akane.waseda.jp',
  canSend: true,
  status: 'active',
  connectedAt: 1_700_000_000_000,
  lastUsedAt: null,
  endReason: null,
  ...over,
});

const info = (over: Partial<MailInfo> = {}): MailInfo => ({
  connection: null,
  slotsLeft: 5,
  hasSlot: false,
  idleDays: 90,
  ...over,
});

describe('mailView', () => {
  it('shows the live connection', () => {
    expect(mailView(info({ connection: connection() }))).toBe('active');
  });

  it('shows a broken connection even when no slot is free', () => {
    const broken = connection({ status: 'invalid', endReason: 'idle' });
    expect(mailView(info({ connection: broken, slotsLeft: 0, hasSlot: true }))).toBe('invalid');
  });

  it('offers to connect while slots remain, when unlimited, or when this user holds one', () => {
    expect(mailView(info({ slotsLeft: 1 }))).toBe('connect');
    expect(mailView(info({ slotsLeft: null }))).toBe('connect');
    expect(mailView(info({ slotsLeft: 0, hasSlot: true }))).toBe('connect');
  });

  it('shows the full notice without a free or held slot', () => {
    expect(mailView(info({ slotsLeft: 0 }))).toBe('full');
  });
});

describe('canReconnectMail', () => {
  it('is offered for a broken or read-only connection only', () => {
    expect(canReconnectMail(connection())).toBe(false);
    expect(canReconnectMail(connection({ canSend: false }))).toBe(true);
    expect(canReconnectMail(connection({ status: 'invalid', endReason: 'revoked' }))).toBe(true);
  });
});

describe('isoOfMs', () => {
  it('converts epoch milliseconds and keeps null', () => {
    expect(isoOfMs(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(isoOfMs(null)).toBeNull();
  });
});

describe('mailResultNotice', () => {
  it('maps every result Google can return', () => {
    expect(mailResultNotice('connected')).toEqual({ key: 'mail.result.connected', tone: 'success' });
    expect(mailResultNotice('denied')?.tone).toBe('info');
    expect(mailResultNotice('full')?.key).toBe('mail.full');
    for (const r of ['expired', 'domain', 'scope', 'failed', 'session']) {
      expect(mailResultNotice(r)?.tone).toBe('error');
    }
    expect(mailResultNotice('session')?.key).toBe(mailResultNotice('failed')?.key);
  });

  it('ignores missing and unknown values', () => {
    expect(mailResultNotice(null)).toBeNull();
    expect(mailResultNotice('')).toBeNull();
    expect(mailResultNotice('nope')).toBeNull();
    expect(mailResultNotice('toString')).toBeNull();
  });
});

describe('withoutMailParam', () => {
  it('drops only the mail parameter', () => {
    expect(withoutMailParam('https://app.example.com/settings/mail?mail=connected')).toBe('/settings/mail');
    expect(withoutMailParam('https://app.example.com/settings/mail?a=1&mail=denied#x')).toBe('/settings/mail?a=1#x');
  });
});
