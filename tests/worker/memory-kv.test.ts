import { describe, expect, it } from 'vitest';
import { MemoryKV } from '../helpers/memory-kv';

describe('MemoryKV.list', () => {
  it('honours prefix, limit and cursor like the real namespace', async () => {
    const kv = new MemoryKV();
    for (const k of ['a:1', 'a:2', 'a:3', 'b:1']) await kv.put(k, 'v');
    const first = await kv.list({ prefix: 'a:', limit: 2 });
    expect(first.keys.map((k) => k.name)).toEqual(['a:1', 'a:2']);
    expect(first.list_complete).toBe(false);
    const second = await kv.list({ prefix: 'a:', limit: 2, cursor: 'cursor' in first ? first.cursor : undefined });
    expect(second.keys.map((k) => k.name)).toEqual(['a:3']);
    expect(second.list_complete).toBe(true);
  });
});
