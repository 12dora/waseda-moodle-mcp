/**
 * A fake WebSession for adapter tests: pages and ajax answers by path / function name. Invented data only.
 * `calls` logs every request: 'GET /path', 'POST /path', 'ajax fn'.
 */

import { MoodleError } from '../../src/core/errors';
import type { WebPage, WebRequest, WebSession } from '../../src/core/moodle/web/types';

const BASE = 'https://wsdmoodle.waseda.jp';

type PageEntry = string | ((req: WebRequest) => WebPage | Promise<WebPage>);
type AjaxFn = (args: Record<string, unknown>) => unknown;

interface FakeWebSessionOptions {
  moodleUserId?: number;
  pages?: Record<string, PageEntry>;
  /** A value is the answer's data; a function computes it from the args (it may throw). */
  ajax?: Record<string, unknown>;
}

type FakeWebSession = WebSession & { calls: string[] };

const relative = (path: string) => (path.startsWith(BASE) ? path.slice(BASE.length) : path);

export function makeFakeWebSession(opts: FakeWebSessionOptions = {}): FakeWebSession {
  const calls: string[] = [];
  const pages = opts.pages ?? {};
  const ajax = opts.ajax ?? {};
  return {
    baseUrl: BASE,
    moodleUserId: opts.moodleUserId ?? 7001,
    calls,
    async ajax<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
      calls.push(`ajax ${fn}`);
      if (!Object.hasOwn(ajax, fn)) throw new MoodleError(`${fn} is not faked`, 'servicenotavailable');
      const entry = ajax[fn];
      return (typeof entry === 'function' ? await (entry as AjaxFn)(args) : entry) as T;
    },
    async page(path: string, req: WebRequest = {}): Promise<WebPage> {
      const rel = relative(path);
      calls.push(`${req.method ?? 'GET'} ${rel}`);
      if (!Object.hasOwn(pages, rel)) throw new MoodleError('not found', 'invalidrecord');
      const entry = pages[rel];
      if (typeof entry === 'function') return entry(req);
      return { url: `${BASE}${rel}`, status: 200, html: entry ?? '', location: null };
    },
    async sesskey(): Promise<string> {
      return 'fakesesskey01';
    },
  };
}
