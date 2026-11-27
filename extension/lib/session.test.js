import { describe, expect, it } from 'vitest';
import {
  createSessionWatcher,
  isSignedInAnswer,
  PROBE_BODY,
  PROBE_URL,
  refreshResult,
  SESSION_COOKIE,
} from './session.js';

const cookie = (value, extra = {}) => ({ name: 'MoodleSession', domain: 'wsdmoodle.waseda.jp', value, ...extra });
const set = (value, extra) => ({ cookie: cookie(value, extra), removed: false, cause: 'explicit' });
const removed = (value, cause) => ({ cookie: cookie(value), removed: true, cause });

describe('session cookie query and probe', () => {
  it('reads only MoodleSession of Waseda Moodle', () => {
    expect(SESSION_COOKIE).toEqual({ url: 'https://wsdmoodle.waseda.jp/', name: 'MoodleSession' });
  });
  it('probes the ajax service with a dummy sesskey', () => {
    expect(PROBE_URL).toBe('https://wsdmoodle.waseda.jp/lib/ajax/service.php?sesskey=probe');
    expect(PROBE_BODY).toHaveLength(1);
  });
});

describe('isSignedInAnswer', () => {
  it('accepts a rejected sesskey in either answer shape', () => {
    expect(isSignedInAnswer([{ error: true, exception: { errorcode: 'invalidsesskey' } }])).toBe(true);
    expect(isSignedInAnswer({ error: 'x', errorcode: 'invalidsesskey' })).toBe(true);
  });
  it('rejects signed-out and unexpected answers', () => {
    expect(isSignedInAnswer([{ error: true, exception: { errorcode: 'servicerequireslogin' } }])).toBe(false);
    expect(isSignedInAnswer({ errorcode: 'servicerequireslogin' })).toBe(false);
    expect(isSignedInAnswer([])).toBe(false);
    expect(isSignedInAnswer(null)).toBe(false);
  });
});

describe('createSessionWatcher', () => {
  it('reports a cookie that appears', () => {
    expect(createSessionWatcher()(set('alpha'))).toBe(true);
  });
  it('reports an overwrite with a new value', () => {
    const isNew = createSessionWatcher();
    expect(isNew(removed('alpha', 'overwrite'))).toBe(false);
    expect(isNew(set('beta'))).toBe(true);
  });
  it('ignores a rewrite of the same value', () => {
    const isNew = createSessionWatcher();
    isNew(removed('alpha', 'overwrite'));
    expect(isNew(set('alpha'))).toBe(false);
  });
  it('reports a value that comes back after a removal', () => {
    const isNew = createSessionWatcher();
    expect(isNew(removed('alpha', 'explicit'))).toBe(false);
    expect(isNew(set('alpha'))).toBe(true);
  });
  it('accepts a domain cookie', () => {
    expect(createSessionWatcher()(set('alpha', { domain: '.wsdmoodle.waseda.jp' }))).toBe(true);
  });
  it('ignores empty values, other cookies and other hosts', () => {
    const isNew = createSessionWatcher();
    expect(isNew(set(''))).toBe(false);
    expect(isNew(set('alpha', { name: 'MOODLEID1_' }))).toBe(false);
    expect(isNew(set('alpha', { domain: 'moodle.example.com' }))).toBe(false);
  });
});

describe('refreshResult', () => {
  it('maps successful answers', () => {
    expect(refreshResult(200, { status: 'unchanged' })).toBe('unchanged');
    expect(refreshResult(200, { status: 'updated' })).toBe('updated');
    expect(refreshResult(200, null)).toBe('updated');
  });
  it('maps failures by status', () => {
    expect(refreshResult(404, null)).toBe('unknown_user');
    expect(refreshResult(409, null)).toBe('signin_required');
    expect(refreshResult(429, null)).toBe('rate_limited');
    expect(refreshResult(400, null)).toBe('server_error');
    expect(refreshResult(502, null)).toBe('server_error');
  });
});
