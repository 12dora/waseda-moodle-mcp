import { describe, expect, it, vi } from 'vitest';
import { InvocationBudget } from '../../src/core/budget';
import {
  BudgetExceeded,
  Forbidden,
  InvalidInput,
  MailNeedsReconnect,
  MailUnavailable,
  NotFound,
  RateLimited,
} from '../../src/core/errors';
import { GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE, GmailClient, revokeGoogleToken } from '../../src/core/mail/client';
import { MAIL_RECONNECT } from '../../src/core/mail/connection';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me/';

interface Seen {
  url: string;
  method: string;
  auth: string | null;
  body: string;
}

type Handler = (req: Seen, n: number) => Response | Promise<Response>;

let tokenSeq = 0;
/** The access-token cache is per isolate (module): every test uses its own refresh token. */
const freshRefresh = () => `refresh-${++tokenSeq}-${Math.random()}`;

function fakeFetch(opts: { token?: Handler; gmail?: Handler }) {
  const seen: Seen[] = [];
  let tokenCalls = 0;
  let gmailCalls = 0;
  let issued = 0;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req: Seen = {
      url: String(input),
      method: init?.method ?? 'GET',
      auth: new Headers(init?.headers).get('Authorization'),
      body: typeof init?.body === 'string' ? init.body : '',
    };
    seen.push(req);
    if (req.url === TOKEN_URL) {
      tokenCalls++;
      if (opts.token) return opts.token(req, tokenCalls);
      issued++;
      return Response.json({ access_token: `at-${issued}`, expires_in: 3600, token_type: 'Bearer' });
    }
    gmailCalls++;
    return opts.gmail ? opts.gmail(req, gmailCalls) : Response.json({ ok: true });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen, counts: () => ({ token: tokenCalls, gmail: gmailCalls }) };
}

function client(f: { fetch: typeof fetch }, over: Partial<ConstructorParameters<typeof GmailClient>[0]> = {}) {
  return new GmailClient({
    address: 'taro@akane.waseda.jp',
    scopes: [GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE],
    refreshToken: freshRefresh(),
    clientId: 'cid.apps.googleusercontent.com',
    clientSecret: 'secret',
    fetch: f.fetch,
    ...over,
  });
}

const failure = (p: Promise<unknown>): Promise<unknown> => p.catch((e: unknown) => e);

const googleError = (status: number, message: string, reason?: string) =>
  Response.json({ error: { code: status, message, errors: reason ? [{ reason }] : [] } }, { status });

describe('GmailClient tokens', () => {
  it('refreshes with the refresh token, then calls Gmail with the access token', async () => {
    const f = fakeFetch({});
    const refreshToken = freshRefresh();
    const c = client(f, { refreshToken });
    expect(await c.get('messages', { q: 'in:inbox', maxResults: 5 })).toEqual({ ok: true });
    const [tok, call] = f.seen;
    expect(tok?.method).toBe('POST');
    const form = new URLSearchParams(tok?.body);
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: 'cid.apps.googleusercontent.com',
      client_secret: 'secret',
    });
    expect(call?.url).toBe(`${GMAIL}messages?q=in%3Ainbox&maxResults=5`);
    expect(call?.auth).toBe('Bearer at-1');
    expect(c.callsMade).toBe(2);
  });

  it('reuses a cached access token across clients of the same refresh token', async () => {
    const f = fakeFetch({});
    const refreshToken = freshRefresh();
    await client(f, { refreshToken }).get('labels');
    const second = client(f, { refreshToken });
    await second.get('labels');
    expect(f.counts()).toEqual({ token: 1, gmail: 2 });
    expect(second.callsMade).toBe(1);
  });

  it('does not reuse a token close to its expiry', async () => {
    const f = fakeFetch({
      token: (_r, n) => Response.json({ access_token: `short-${n}`, expires_in: 30 }),
    });
    const refreshToken = freshRefresh();
    await client(f, { refreshToken }).get('labels');
    await client(f, { refreshToken }).get('labels');
    expect(f.counts().token).toBe(2);
  });

  it('on a 401 drops the token, refreshes and retries once', async () => {
    const f = fakeFetch({
      gmail: (req) => (req.auth === 'Bearer at-1' ? new Response('', { status: 401 }) : Response.json({ id: 'm1' })),
    });
    const c = client(f);
    expect(await c.get('messages/m1')).toEqual({ id: 'm1' });
    expect(f.counts()).toEqual({ token: 2, gmail: 2 });
    expect(f.seen.at(-1)?.auth).toBe('Bearer at-2');
  });

  it('a second 401 asks to reconnect', async () => {
    const f = fakeFetch({ gmail: () => new Response('', { status: 401 }) });
    const err = await failure(client(f).get('labels'));
    expect(err).toBeInstanceOf(MailNeedsReconnect);
    expect((err as Error).message).toBe(MAIL_RECONNECT);
  });

  it('invalid_grant marks the connection invalid and asks to reconnect', async () => {
    const onInvalid = vi.fn(async () => undefined);
    const f = fakeFetch({ token: () => Response.json({ error: 'invalid_grant' }, { status: 400 }) });
    const c = client(f, { onInvalid });
    const err = await failure(c.get('labels'));
    expect(err).toBeInstanceOf(MailNeedsReconnect);
    expect((err as Error).message).toBe(MAIL_RECONNECT);
    expect(onInvalid).toHaveBeenCalledTimes(1);
    expect(f.counts().gmail).toBe(0);
  });

  it('a failing token endpoint is MailUnavailable and is tried again on the next call', async () => {
    const f = fakeFetch({
      token: (_r, n) => (n === 1 ? new Response('', { status: 503 }) : Response.json({ access_token: 'ok' })),
    });
    const c = client(f);
    // GET retries once: the second attempt refreshes again and succeeds
    expect(await c.get('labels')).toEqual({ ok: true });
    expect(f.counts()).toEqual({ token: 2, gmail: 1 });
  });

  it('a failed refresh means the Gmail request was never sent (maybeSent false)', async () => {
    const down = fakeFetch({ token: () => new Response('', { status: 503 }) });
    const err = await failure(client(down).post('messages/send', { raw: 'abc' }));
    expect(err).toBeInstanceOf(MailUnavailable);
    expect((err as MailUnavailable).maybeSent).toBe(false);
    expect(down.counts().gmail).toBe(0);

    const unreachable = fakeFetch({
      token: () => {
        throw new TypeError('network');
      },
    });
    const err2 = await failure(client(unreachable).post('messages/send', { raw: 'abc' }));
    expect((err2 as MailUnavailable).maybeSent).toBe(false);
  });
});

describe('GmailClient requests', () => {
  it('repeats array query values and encodes path segments', async () => {
    const f = fakeFetch({});
    await client(f).get('messages/a b', { format: 'metadata', metadataHeaders: ['From', 'Subject'], x: undefined });
    const query = 'format=metadata&metadataHeaders=From&metadataHeaders=Subject';
    expect(f.seen[1]?.url).toBe(`${GMAIL}messages/a%20b?${query}`);
    await expect(client(f).get('messages/../profile')).rejects.toBeInstanceOf(InvalidInput);
  });

  it('POSTs JSON and never retries a failed POST', async () => {
    const f = fakeFetch({ gmail: () => new Response('', { status: 502 }) });
    const c = client(f);
    const err = await failure(c.post('messages/send', { raw: 'abc' }));
    expect(err).toBeInstanceOf(MailUnavailable);
    expect((err as MailUnavailable).maybeSent).toBe(true);
    expect(f.counts().gmail).toBe(1);
    expect(f.seen[1]?.body).toBe('{"raw":"abc"}');

    const lost = fakeFetch({
      gmail: () => {
        throw new TypeError('network');
      },
    });
    const err2 = await failure(client(lost).post('messages/send', { raw: 'abc' }));
    expect((err2 as MailUnavailable).maybeSent).toBe(true);
  });

  it('throws MailUnavailable when a 200 body cannot be read (no empty search / file)', async () => {
    const broken = () =>
      Object.assign(new Response('payload', { status: 200 }), {
        text: () => Promise.reject(new TypeError('aborted')),
      });
    const post = fakeFetch({ gmail: broken });
    const err = await failure(client(post).post('messages/send', { raw: 'abc' }));
    expect(err).toBeInstanceOf(MailUnavailable);
    expect((err as MailUnavailable).maybeSent).toBe(true);
    expect(post.counts().gmail).toBe(1);

    const get = fakeFetch({
      gmail: (_r, n) => (n === 1 ? broken() : Response.json({ messages: [{ id: 'm1' }] })),
    });
    expect(await client(get).get('messages')).toEqual({ messages: [{ id: 'm1' }] });
    expect(get.counts().gmail).toBe(2);
  });

  it('throws MailUnavailable when a 200 JSON body is empty', async () => {
    const f = fakeFetch({ gmail: () => new Response('', { status: 200 }) });
    await expect(client(f).get('messages')).rejects.toBeInstanceOf(MailUnavailable);
  });

  it('retries a GET once on a 5xx or a network error', async () => {
    const f = fakeFetch({
      gmail: (_r, n) => {
        if (n === 1) throw new TypeError('network');
        return Response.json({ id: 'x' });
      },
    });
    expect(await client(f).get('messages/x')).toEqual({ id: 'x' });
    const g = fakeFetch({ gmail: () => new Response('', { status: 500 }) });
    await expect(client(g).get('messages/x')).rejects.toBeInstanceOf(MailUnavailable);
    expect(g.counts().gmail).toBe(2);
  });

  it('maps Gmail errors to user-safe errors', async () => {
    const cases: Array<[Response, unknown, string?]> = [
      [new Response('', { status: 429 }), RateLimited],
      [googleError(404, 'Requested entity was not found.'), NotFound, 'Mail not found.'],
      [googleError(403, 'Insufficient Permission', 'insufficientPermissions'), Forbidden, 'does not allow that'],
      [googleError(403, 'Mail service not enabled'), Forbidden, 'Mail service not enabled'],
      [googleError(400, `Invalid query ${'x'.repeat(300)}`), InvalidInput],
    ];
    for (const [res, type, text] of cases) {
      const f = fakeFetch({ gmail: () => res.clone() });
      const err = await failure(client(f).get('messages'));
      expect(err).toBeInstanceOf(type as new () => Error);
      if (text) expect((err as Error).message).toContain(text);
      expect((err as Error).message.length).toBeLessThanOrEqual(200);
    }
  });

  it('replaces every address in Google error text', async () => {
    const text = 'Invalid To header: jiro@example.com, "Hanako" <hanako.sato@akane.waseda.jp>; x@y';
    for (const status of [400, 403]) {
      const f = fakeFetch({ gmail: () => googleError(status, text) });
      const err = await failure(client(f).post('messages/send', { raw: 'abc' }));
      expect(err).toBeInstanceOf(status === 400 ? InvalidInput : Forbidden);
      expect((err as Error).message).toBe('Invalid To header: <address>, "Hanako" <<address>>; <address>');
    }
  });

  it('calls onUsed once after the first successful Gmail call', async () => {
    const onUsed = vi.fn();
    const c = client(fakeFetch({}), { onUsed });
    await c.get('labels');
    await c.get('labels');
    expect(onUsed).toHaveBeenCalledTimes(1);
    const notUsed = vi.fn();
    const failing = client(fakeFetch({ gmail: () => new Response('', { status: 404 }) }), { onUsed: notUsed });
    await failure(failing.get('labels'));
    expect(notUsed).not.toHaveBeenCalled();
  });

  it('canSend follows the granted scopes', () => {
    const f = fakeFetch({});
    expect(client(f).canSend).toBe(true);
    expect(client(f, { scopes: [GMAIL_READ_SCOPE] }).canSend).toBe(false);
  });
});

describe('GmailClient budget', () => {
  it('charges every subrequest (refresh included) to the shared budget', async () => {
    const budget = new InvocationBudget(2, 10);
    const c = client(fakeFetch({}), { budget });
    await c.get('labels');
    expect(budget.moodle).toBe(0);
    await expect(c.get('labels')).rejects.toBeInstanceOf(BudgetExceeded);
  });

  it('stops at maxCalls', async () => {
    const c = client(fakeFetch({}), { maxCalls: 2 });
    await c.get('labels');
    const err = await failure(c.get('labels'));
    expect(err).toBeInstanceOf(BudgetExceeded);
    expect((err as Error).message).toContain('mail');
    expect(c.callsMade).toBe(2);
  });
});

describe('revokeGoogleToken', () => {
  it('posts the token and reports whether Google answered', async () => {
    const seen: string[] = [];
    const ok = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      seen.push(String(init?.body));
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    expect(await revokeGoogleToken('tok/1', ok)).toBe(true);
    expect(seen).toEqual(['token=tok%2F1']);
    const gone = (async () => new Response('', { status: 400 })) as unknown as typeof fetch;
    expect(await revokeGoogleToken('t', gone)).toBe(true);
    const down = (async () => {
      throw new TypeError('network');
    }) as unknown as typeof fetch;
    expect(await revokeGoogleToken('t', down)).toBe(false);
  });
});
