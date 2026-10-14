/**
 * Minimal ServiceContext with a fake MoodleApi keyed by wsfunction (BE-3 tests).
 * Handlers get the call params; return the payload or throw (e.g. a MoodleError). Unknown functions throw.
 */

import type { MoodleApi, ServiceContext, Signer, Store } from '../../src/core/context';
import { MoodleError } from '../../src/core/errors';
import { DEFAULT_SETTINGS } from '../../src/core/types';

export type Handler = (params: Record<string, unknown>) => unknown;

export interface FakeCall {
  fn: string;
  params: Record<string, unknown>;
}

export interface FakeContextOptions {
  moodleUserId?: number;
  fullname?: string;
  lang?: string;
  hiddenCourseIds?: number[];
}

export const FAKE_BASE_URL = 'https://moodle.example.com';

export function makeFakeContext(
  handlers: Record<string, Handler | unknown>,
  opts: FakeContextOptions = {},
): { ctx: ServiceContext; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const moodleUserId = opts.moodleUserId ?? 1001;
  const api: MoodleApi = {
    baseUrl: FAKE_BASE_URL,
    moodleUserId,
    get callsMade() {
      return calls.length;
    },
    async call<T = unknown>(fn: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push({ fn, params });
      if (!(fn in handlers)) throw new MoodleError(`no fake handler for ${fn}`, 'fake_unhandled');
      const h = handlers[fn];
      return (typeof h === 'function' ? await (h as Handler)(params) : h) as T;
    },
    async fetchFile() {
      throw new Error('fetchFile is not used in BE-3 tests');
    },
    async uploadToDraft() {
      throw new Error('uploadToDraft is not used in BE-3 tests');
    },
  };
  const signer: Signer = {
    async sign() {
      return 'ticket';
    },
    async verify() {
      return null;
    },
  };
  const ctx: ServiceContext = {
    user: {
      id: 1,
      moodleUserId,
      fullname: opts.fullname ?? 'Taro Yamada',
      lang: opts.lang ?? 'en',
      settings: { ...DEFAULT_SETTINGS, hiddenCourseIds: opts.hiddenCourseIds ?? [] },
      createdAt: 0,
      lastSeenAt: null,
    },
    store: {} as Store,
    signer,
    moodle: async () => api,
    publicUrl: 'https://wasemoodle.example.com',
    mode: 'worker',
    scopes: ['moodle:read'],
    source: 'test',
    defer: () => {},
  };
  return { ctx, calls };
}

export const countCalls = (calls: FakeCall[], fn: string) => calls.filter((c) => c.fn === fn).length;
