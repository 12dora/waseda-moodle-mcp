/**
 * Several Moodle web-service calls in ONE HTTP request (`tool_mobile_call_external_functions`), so a due listing stays
 * far below the Workers subrequest limit. Each chunk counts as a single call in the request's Moodle budget.
 */

import type { MoodleApi } from '../../context';
import { isObj } from '../../moodle/wire';

const BATCH_FN = 'tool_mobile_call_external_functions';
const CHUNK_SIZE = 40;

export interface BatchRequest {
  fn: string;
  args: Record<string, unknown>;
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

/** Results line up with `requests`; a failing chunk (network, budget, token) fails its requests only. Never throws. */
export async function callBatch(api: MoodleApi, requests: readonly BatchRequest[]): Promise<BatchResult[]> {
  const chunks: BatchRequest[][] = [];
  for (let i = 0; i < requests.length; i += CHUNK_SIZE) chunks.push(requests.slice(i, i + CHUNK_SIZE));
  const results = await Promise.all(chunks.map((c) => runChunk(api, c)));
  return results.flat();
}
