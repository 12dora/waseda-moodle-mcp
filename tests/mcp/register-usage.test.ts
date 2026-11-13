import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import type { ServiceContext } from '../../src/core/context';
import { MoodleUnavailable, WmmError } from '../../src/core/errors';
import { defineTool } from '../../src/core/mcp/tools/define';
import { registerTool } from '../../src/core/mcp/tools/register';
import { MoodleClient } from '../../src/core/moodle/client';
import { makeFakeContext } from '../helpers/fake-context';

const okTool = defineTool({
  name: 'ping',
  title: 'Ping',
  description: 'Always succeeds.',
  annotations: { readOnlyHint: true },
  input: z.object({}),
  output: z.object({}).passthrough(),
  run: async () => ({ text: 'pong', data: {} }),
});

const failTool = defineTool({
  ...okTool,
  name: 'boom',
  description: 'Always fails.',
  run: async () => {
    throw new WmmError('nope', 'invalid_input');
  },
});

const slowTool = defineTool({
  ...okTool,
  name: 'slow',
  description: 'Fails after a while.',
  run: async () => {
    await new Promise((r) => setTimeout(r, 25));
    throw new MoodleUnavailable();
  },
});

/** One Moodle read, so a token renewal inside the client happens within this single tool call. */
const siteTool = defineTool({
  ...okTool,
  name: 'site',
  description: 'Reads the site info.',
  run: async (ctx) => {
    const info = await (await ctx.moodle()).call('core_webservice_get_site_info');
    return { text: 'ok', data: { info } };
  },
});

const open: Client[] = [];

async function connect(ctx: ServiceContext): Promise<Client> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerTool(server, ctx, okTool);
  registerTool(server, ctx, failTool);
  registerTool(server, ctx, slowTool);
  registerTool(server, ctx, siteTool);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  open.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
});

/** [tool, failure class] per counted call (wall time checked separately). */
function recorder(): { calls: [string, string | null][]; ms: number[]; usage: ServiceContext['usage'] } {
  const calls: [string, string | null][] = [];
  const ms: number[] = [];
  return {
    calls,
    ms,
    usage: {
      toolCall: (c) => {
        calls.push([c.tool, c.failure]);
        ms.push(c.ms);
      },
    },
  };
}

describe('registerTool usage counting', () => {
  it('reports each tool call with its failure class and wall time, and nothing else', async () => {
    const rec = recorder();
    const { ctx } = makeFakeContext();
    const client = await connect({ ...ctx, usage: rec.usage });
    await client.listTools();
    expect(rec.calls).toEqual([]);
    await client.callTool({ name: 'ping', arguments: {} });
    expect((await client.callTool({ name: 'boom', arguments: {} })).isError).toBe(true);
    expect((await client.callTool({ name: 'slow', arguments: {} })).isError).toBe(true);
    expect(rec.calls).toEqual([
      ['ping', null],
      ['boom', 'invalid_input'],
      ['slow', 'moodle_unavailable'],
    ]);
    for (const ms of rec.ms) expect(ms).toBeGreaterThanOrEqual(0);
    expect(rec.ms[2]).toBeGreaterThanOrEqual(20); // the handler's own wall time
  });

  it('works without a recorder (stdio) and survives a recorder that throws', async () => {
    const { ctx } = makeFakeContext({ mode: 'stdio' });
    const plain = await connect(ctx);
    expect((await plain.callTool({ name: 'ping', arguments: {} })).isError).toBeFalsy();

    const throwing = await connect({
      ...ctx,
      usage: {
        toolCall: () => {
          throw new Error('recorder down');
        },
      },
    });
    const res = await throwing.callTool({ name: 'ping', arguments: {} });
    expect(res.isError).toBeFalsy();
    expect((await throwing.callTool({ name: 'boom', arguments: {} })).isError).toBe(true);
  });

  it('counts a call renewed and retried inside the client as one call, by its final outcome', async () => {
    const NEW = 'fedcba9876543210fedcba9876543210';
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      new URLSearchParams(String(init?.body)).get('wstoken') === NEW
        ? Response.json({ userid: 1001 })
        : Response.json({ exception: 'moodle_exception', errorcode: 'invalidtoken', message: 'Invalid token' }),
    ) as unknown as typeof globalThis.fetch;
    const rec = recorder();
    const { ctx } = makeFakeContext();
    const withRenewal = (renewToken: () => Promise<string | null>): ServiceContext => ({
      ...ctx,
      moodle: async () => new MoodleClient({ token: '0'.repeat(32), moodleUserId: 1001, fetch, renewToken }),
      usage: rec.usage,
    });

    const renewed = await connect(withRenewal(async () => NEW));
    expect((await renewed.callTool({ name: 'site', arguments: {} })).isError).toBeFalsy();
    const failed = await connect(withRenewal(async () => null));
    expect((await failed.callTool({ name: 'site', arguments: {} })).isError).toBe(true);
    expect(rec.calls).toEqual([
      ['site', null],
      ['site', 'needs_reconnect'],
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
