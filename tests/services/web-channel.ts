/**
 * A MoodleApi on the web channel for service tests: `web` is a fake WebSession (pages by path), `call` answers from
 * handlers by function name (the emulated web-service functions). `callsMade` counts calls and page requests.
 * Invented data only.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CallHint, MoodleApi } from '../../src/core/context';
import { MoodleError } from '../../src/core/errors';
import type { WebPage, WebRequest } from '../../src/core/moodle/web/types';
import { makeFakeWebSession } from '../helpers/fake-web-session';

export const fixture = (name: string): string => readFileSync(join(__dirname, '../fixtures/web', name), 'utf8');

type HandlerFn = (params: Record<string, unknown>, hint?: CallHint) => unknown;
type Handler = unknown | HandlerFn;
type PageEntry = string | ((req: WebRequest) => WebPage | Promise<WebPage>);

export interface WebApiOptions {
  pages?: Record<string, PageEntry>;
  handlers?: Record<string, Handler>;
  /** Calls already spent before the code under test runs. */
  spent?: number;
}

export type WebApi = MoodleApi & {
  calls: Array<{ fn: string; params: Record<string, unknown>; hint?: CallHint }>;
  pageCalls: string[];
};

export function makeWebApi(opts: WebApiOptions = {}): WebApi {
  const web = makeFakeWebSession({ pages: opts.pages });
  const calls: WebApi['calls'] = [];
  const handlers = opts.handlers ?? {};
  return {
    baseUrl: web.baseUrl,
    moodleUserId: web.moodleUserId,
    channel: 'web',
    web,
    calls,
    pageCalls: web.calls,
    get callsMade() {
      return (opts.spent ?? 0) + calls.length + web.calls.length;
    },
    async call<T>(fn: string, params: Record<string, unknown> = {}, hint?: CallHint): Promise<T> {
      calls.push({ fn, params, hint });
      if (!Object.hasOwn(handlers, fn)) throw new MoodleError(`fake: no handler for ${fn}`, 'nohandler');
      const h = handlers[fn];
      return (typeof h === 'function' ? await (h as HandlerFn)(params, hint) : h) as T;
    },
    fetchFile: () => Promise.reject(new Error('fetchFile is not used here')),
    uploadToDraft: () => Promise.reject(new Error('uploadToDraft is not used here')),
  };
}

/** A redirect answer to a POST (Moodle's answer to a saved form). */
export const redirectTo = (path: string): WebPage => ({
  url: `https://wsdmoodle.waseda.jp${path}`,
  status: 303,
  html: '',
  location: `https://wsdmoodle.waseda.jp${path}`,
});

/** A page answer (Moodle re-rendering a form, or showing the next page). */
export const pageOf = (path: string, html: string): WebPage => ({
  url: `https://wsdmoodle.waseda.jp${path}`,
  status: 200,
  html,
  location: null,
});
