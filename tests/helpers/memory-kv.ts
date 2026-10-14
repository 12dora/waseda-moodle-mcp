/** In-memory KVNamespace double (get/put/delete/list with TTL) for Worker tests. */

interface Entry {
  value: string;
  expiresAt: number | null;
}

type GetType = 'text' | 'json' | 'arrayBuffer' | 'stream';

export class MemoryKV {
  readonly data = new Map<string, Entry>();
  /** Operation counters so tests can assert how chatty the code is (Free KV: 1000 writes/day). */
  readonly ops = { get: 0, put: 0, delete: 0, list: 0 };
  /** Overridable clock for TTL tests. */
  now = () => Date.now();

  private live(key: string): Entry | undefined {
    const e = this.data.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== null && e.expiresAt <= this.now()) {
      this.data.delete(key);
      return undefined;
    }
    return e;
  }

  async get(key: string, typeOrOpts?: GetType | { type?: GetType }): Promise<unknown> {
    this.ops.get++;
    const e = this.live(key);
    if (!e) return null;
    const type = typeof typeOrOpts === 'string' ? typeOrOpts : (typeOrOpts?.type ?? 'text');
    if (type === 'json') return JSON.parse(e.value);
    return e.value;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number; expiration?: number }): Promise<void> {
    this.ops.put++;
    let expiresAt: number | null = null;
    if (opts?.expirationTtl) expiresAt = this.now() + opts.expirationTtl * 1000;
    else if (opts?.expiration) expiresAt = opts.expiration * 1000;
    this.data.set(key, { value, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.ops.delete++;
    this.data.delete(key);
  }

  async list(opts?: { prefix?: string; limit?: number }) {
    this.ops.list++;
    const keys = [...this.data.keys()]
      .filter((k) => this.live(k) && (!opts?.prefix || k.startsWith(opts.prefix)))
      .sort()
      .slice(0, opts?.limit ?? 1000)
      .map((name) => ({ name }));
    return { keys, list_complete: true, cacheStatus: null };
  }

  asKV(): KVNamespace {
    return this as unknown as KVNamespace;
  }
}
