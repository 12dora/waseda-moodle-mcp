/**
 * Several Moodle web-service calls at once. Web-service channel: ONE HTTP request per chunk
 * (`tool_mobile_call_external_functions`), so a due listing stays far below the Workers subrequest limit; each chunk
 * counts as a single call in the request's Moodle budget. Web channel: that batch function does not exist; the calls
 * run one by one through the client (at most CONCURRENCY at a time; ajax ones of one tick share a request, emulated
 * ones read a page each), so callers bound the number of requests themselves.
 */

import type { CallHint, MoodleApi } from '../../context';
import { isObj } from '../../moodle/wire';

const BATCH_FN = 'tool_mobile_call_external_functions';
const CHUNK_SIZE = 40;
const CONCURRENCY = 6;

export interface BatchRequest {
  fn: string;
  args: Record<string, unknown>;
  /** What the caller knows (the activity's cmid): the web channel reads only that activity. */
  hint?: CallHint;
}

export type BatchResult = { ok: true; data: unknown } | { ok: false };

const FAILED: BatchResult = { ok: false };

/** `{ error: boolean, data?: <JSON string>, exception?: … }` per request; an error or unreadable data is a failure. */
function decode(raw: unknown): BatchResult {
  if (!isObj(raw) || raw.error === true || typeof raw.data !== 'string') return FAILED;
  try {
    return { ok: true, data: JSON.parse(raw.data) };
  } catch {
    return FAILED;
  }
}

async function runChunk(api: MoodleApi, chunk: readonly BatchRequest[]): Promise<BatchResult[]> {
  const requests = chunk.map((r) => ({ function: r.fn, arguments: JSON.stringify(r.args) }));
  try {
    const res = await api.call<unknown>(BATCH_FN, { requests });
    const responses = isObj(res) && Array.isArray(res.responses) ? res.responses : [];
    return chunk.map((_, i) => decode(responses[i]));
  } catch {
    return chunk.map(() => FAILED);
  }
}

/** `fn` over `items` with at most `limit` running at a time; results in input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The web channel: every request on its own, a failure failing that request only. */
function runEach(api: MoodleApi, requests: readonly BatchRequest[]): Promise<BatchResult[]> {
  return mapLimit(requests, CONCURRENCY, (r) =>
    api.call<unknown>(r.fn, r.args, r.hint).then(
      (data): BatchResult => ({ ok: true, data }),
      (): BatchResult => FAILED,
    ),
  );
}

/** Results line up with `requests`; a failing chunk (network, budget, token) fails its requests only. Never throws. */
export async function callBatch(api: MoodleApi, requests: readonly BatchRequest[]): Promise<BatchResult[]> {
  if (api.channel === 'web') return runEach(api, requests);
  const chunks: BatchRequest[][] = [];
  for (let i = 0; i < requests.length; i += CHUNK_SIZE) chunks.push(requests.slice(i, i + CHUNK_SIZE));
  const results = await Promise.all(chunks.map((c) => runChunk(api, c)));
  return results.flat();
}
