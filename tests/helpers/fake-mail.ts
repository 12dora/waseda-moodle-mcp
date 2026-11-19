/** Fake MailApi for service/tool tests: canned answers by "METHOD path" (or a function of the query / body). */

import type { MailApi, MailQuery } from '../../src/core/context';
import { NotFound } from '../../src/core/errors';

type AnswerFn = (input: { query?: MailQuery; body?: unknown }) => unknown;
type Answer = AnswerFn | object | string | number | boolean | null;

interface FakeMailCall {
  method: 'GET' | 'POST';
  path: string;
  query?: MailQuery;
  body?: unknown;
}

export interface FakeMail extends MailApi {
  calls: FakeMailCall[];
}

export interface FakeMailOptions {
  address?: string;
  canSend?: boolean;
  /** Keys: "GET messages", "GET threads/t1", "POST messages/send". Unknown keys throw NotFound like Gmail's 404. */
  answers?: Record<string, Answer>;
}

export function makeFakeMail(opts: FakeMailOptions = {}): FakeMail {
  const calls: FakeMailCall[] = [];
  const answers = opts.answers ?? {};
  const answer = async (call: FakeMailCall) => {
    calls.push(call);
    const key = `${call.method} ${call.path}`;
    if (!(key in answers)) throw new NotFound('Mail not found.');
    const a = answers[key];
    return typeof a === 'function' ? await a({ query: call.query, body: call.body }) : structuredClone(a);
  };
  return {
    address: opts.address ?? 'taro@akane.waseda.jp',
    canSend: opts.canSend ?? true,
    get callsMade() {
      return calls.length;
    },
    calls,
    get: async <T>(path: string, query?: MailQuery) => (await answer({ method: 'GET', path, query })) as T,
    getText: async (path: string, query?: MailQuery) => {
      const a = await answer({ method: 'GET', path, query });
      return typeof a === 'string' ? a : JSON.stringify(a);
    },
    post: async <T>(path: string, body: unknown) => (await answer({ method: 'POST', path, body })) as T,
  };
}
