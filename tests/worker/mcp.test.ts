import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '../../src/core/context';
import { buildMcpServer } from '../../src/core/mcp/server';
import type { Env } from '../../src/worker/env';
import { mcpApiHandler } from '../../src/worker/mcp';
import { createD1Store } from '../../src/worker/store-d1';
import { createTestD1 } from '../helpers/d1-sqlite';
import { MemoryKV } from '../helpers/memory-kv';

// The real tool surface belongs to BE-5; here only the wiring (props -> ServiceContext -> per-request server) matters.
vi.mock('../../src/core/mcp/server', async () => {
  const { McpServer } = await import('@modelcontextprotocol/server');
  const { z } = await import('zod');
  return {
    buildMcpServer: vi.fn((ctx: ServiceContext) => {
      const server = new McpServer({ name: 'test-server', version: '0.0.1' });
      server.registerTool('whoami', { description: 'who', inputSchema: z.object({}) }, async () => ({
        content: [{ type: 'text' as const, text: `${ctx.user.fullname}|${ctx.scopes.join(',')}|${ctx.source}` }],
      }));
      return server;
    }),
  };
});

const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 3)));

let env: Env;
let userId: number;
let pending: Promise<unknown>[];

beforeEach(async () => {
  pending = [];
  const { db } = createTestD1();
  env = {
    DB: db,
    OAUTH_KV: new MemoryKV().asKV(),
    ASSETS: {} as Fetcher,
    MASTER_KEY,
    PUBLIC_URL: 'https://wasemoodle.example.com',
  } as Env;
  userId = (await createD1Store(db).upsertUser({ moodleUserId: 1001, fullname: 'Taro Yamada', lang: 'ja' })).id;
  vi.mocked(buildMcpServer).mockClear();
});

const execCtx = (props: unknown) =>
  ({
    props,
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => undefined,
  }) as unknown as ExecutionContext;

const rpcRequest = (body: unknown) =>
  new Request('https://wasemoodle.example.com/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });

/** Streamable HTTP answers JSON or a one-event SSE stream depending on the negotiated path. */
async function readRpc(res: Response): Promise<{ result?: Record<string, unknown>; error?: unknown }> {
  const text = await res.text();
  if ((res.headers.get('Content-Type') ?? '').includes('text/event-stream')) {
    const data = text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .find((l) => l.startsWith('{'));
    return JSON.parse(data ?? '{}');
  }
  return JSON.parse(text);
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0.0' } },
};

describe('mcpApiHandler', () => {
  it('rejects calls that carry no usable props', async () => {
    for (const props of [
      undefined,
      {},
      { userId: 'x', scopes: ['moodle:read'] },
      { userId: 1, scopes: 'moodle:read' },
    ]) {
      const res = await mcpApiHandler.fetch(rpcRequest(INIT), env, execCtx(props));
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_token');
    }
    expect(buildMcpServer).not.toHaveBeenCalled();
  });

  it('requires the read scope', async () => {
    const res = await mcpApiHandler.fetch(
      rpcRequest(INIT),
      env,
      execCtx({ userId, scopes: ['moodle:write'], source: 'x' }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('insufficient_scope');
  });

  it('answers 401 when the account no longer exists', async () => {
    const res = await mcpApiHandler.fetch(
      rpcRequest(INIT),
      env,
      execCtx({ userId: 424242, scopes: ['moodle:read'], source: 'x' }),
    );
    expect(res.status).toBe(401);
  });

  it('serves initialize through the SDK handler with a context built from props', async () => {
    const res = await mcpApiHandler.fetch(
      rpcRequest(INIT),
      env,
      execCtx({ userId, scopes: ['moodle:read', 'moodle:write'], source: 'Claude' }),
    );
    expect(res.status).toBe(200);
    const body = await readRpc(res as Response);
    expect((body.result as { serverInfo: { name: string } }).serverInfo.name).toBe('test-server');

    expect(buildMcpServer).toHaveBeenCalledTimes(1);
    const sctx = vi.mocked(buildMcpServer).mock.calls[0]?.[0];
    expect(sctx).toMatchObject({
      mode: 'worker',
      publicUrl: 'https://wasemoodle.example.com',
      scopes: ['moodle:read', 'moodle:write'],
      source: 'Claude',
      user: { id: userId, moodleUserId: 1001 },
    });
  });

  it('builds a fresh server per request and exposes the caller to tools', async () => {
    const props = { userId, scopes: ['moodle:read'], source: 'API key: laptop' };
    const call = async () =>
      mcpApiHandler.fetch(
        rpcRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } }),
        env,
        execCtx(props),
      );
    const first = await readRpc((await call()) as Response);
    const second = await readRpc((await call()) as Response);
    expect(buildMcpServer).toHaveBeenCalledTimes(2);
    const text = (first.result as { content: Array<{ text: string }> }).content[0]?.text;
    expect(text).toBe('Taro Yamada|moodle:read|API key: laptop');
    expect(second.result).toEqual(first.result);
  });

  it('drops unknown scope strings from props', async () => {
    await mcpApiHandler.fetch(rpcRequest(INIT), env, execCtx({ userId, scopes: ['moodle:read', 'admin'], source: '' }));
    const sctx = vi.mocked(buildMcpServer).mock.calls[0]?.[0];
    expect(sctx?.scopes).toEqual(['moodle:read']);
    expect(sctx?.source).toBe('MCP client');
  });
});
