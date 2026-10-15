import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod';
import type { ServiceContext } from '../../src/core/context';
import { WmmError } from '../../src/core/errors';
import { defineTool } from '../../src/core/mcp/tools/define';
import { registerTool } from '../../src/core/mcp/tools/register';
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

const open: Client[] = [];

async function connect(ctx: ServiceContext): Promise<Client> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerTool(server, ctx, okTool);
  registerTool(server, ctx, failTool);
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

describe('registerTool usage counting', () => {
  it('reports each tool call with its outcome, and nothing else', async () => {
    const calls: [string, boolean][] = [];
    const { ctx } = makeFakeContext();
    const client = await connect({ ...ctx, usage: { toolCall: (tool, ok) => void calls.push([tool, ok]) } });
    await client.listTools();
    expect(calls).toEqual([]);
    await client.callTool({ name: 'ping', arguments: {} });
    expect((await client.callTool({ name: 'boom', arguments: {} })).isError).toBe(true);
    expect(calls).toEqual([
      ['ping', true],
      ['boom', false],
    ]);
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
});
