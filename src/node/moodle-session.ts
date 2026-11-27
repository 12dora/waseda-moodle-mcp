/**
 * Moodle access for the long-lived local server. Each tool invocation gets its own client (so the call budget never
 * accumulates across invocations); reads are additionally memoised for a few seconds in a cache shared by all
 * clients, so quick follow-up calls do not repeat the same requests.
 */

import type { CallHint, DraftUploadResult, MoodleApi, MoodleChannel } from '../core/context';
import { type ChannelClientOptions, createChannelClient } from '../core/moodle/web/channel';
import type { WebSession } from '../core/moodle/web/types';

const DEFAULT_TTL_MS = 5000;
/** Moodle web service reads are named ..._get_...; the one allocating "get" is excluded. */
const READ_FN = /_get_(?!unused)/;

export const isCacheableRead = (fn: string) => READ_FN.test(fn);

export class ReadCache {
  private readonly entries = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): Promise<unknown> | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: Promise<unknown>): void {
    this.entries.set(key, { at: this.now(), value });
    value.catch(() => this.entries.delete(key));
  }

  clear(): void {
    this.entries.clear();
  }
}

class CachedMoodle implements MoodleApi {
  constructor(
    private readonly inner: MoodleApi,
    private readonly cache: ReadCache,
  ) {}

  get baseUrl(): string {
    return this.inner.baseUrl;
  }

  get moodleUserId(): number {
    return this.inner.moodleUserId;
  }

  get callsMade(): number {
    return this.inner.callsMade;
  }

  get writesSent(): number | undefined {
    return this.inner.writesSent;
  }

  get channel(): MoodleChannel {
    return this.inner.channel;
  }

  get web(): WebSession | undefined {
    return this.inner.web;
  }

  call<T = unknown>(fn: string, params: Record<string, unknown> = {}, hint?: CallHint): Promise<T> {
    if (!isCacheableRead(fn)) {
      // anything that may change state invalidates what was read before it
      this.cache.clear();
      return this.inner.call<T>(fn, params, hint).finally(() => this.cache.clear());
    }
    // A hint shapes a web answer (one activity, message bodies), which (fn, params) does not say: not shared.
    if (hint !== undefined) return this.inner.call<T>(fn, params, hint);
    const key = `${fn}\u0000${JSON.stringify(params)}`;
    const hit = this.cache.get(key);
    if (hit) return hit as Promise<T>;
    const p = this.inner.call<T>(fn, params);
    this.cache.set(key, p);
    return p;
  }

  fetchFile(fileUrl: string, init?: { method?: 'GET' | 'HEAD'; range?: string }): Promise<Response> {
    return this.inner.fetchFile(fileUrl, init);
  }

  uploadToDraft(
    file: Parameters<MoodleApi['uploadToDraft']>[0],
    itemId: number,
    hint?: CallHint,
  ): Promise<DraftUploadResult> {
    return this.inner.uploadToDraft(file, itemId, hint);
  }
}

/** ServiceContext.moodle for stdio: a fresh client per invocation, sharing one short-lived read cache. */
export function createMoodleProvider(options: () => ChannelClientOptions, cache: ReadCache): () => Promise<MoodleApi> {
  return async () => new CachedMoodle(createChannelClient(options()), cache);
}
