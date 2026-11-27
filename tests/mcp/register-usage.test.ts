import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import type { ServiceContext } from '../../src/core/context';
import {
  MailNeedsReconnect,
  MoodleBusy,
  MoodleError,
  MoodleUnavailable,
  NeedsReconnect,
  WmmError,
} from '../../src/core/errors';
import { MAIL_RECONNECT } from '../../src/core/mail/connection';
import { defineTool } from '../../src/core/mcp/tools/define';
import { registerTool, toToolError } from '../../src/core/mcp/tools/register';
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

describe('toToolError reconnect hints', () => {
  const ORIGIN = 'https://wasemoodle.example.com';

  it('sends mail users to the mail settings page and Moodle users to /connect', () => {
    const { ctx } = makeFakeContext({ publicUrl: ORIGIN });
    const mail = toToolError(ctx, new MailNeedsReconnect(MAIL_RECONNECT));
    expect(mail).toBeInstanceOf(MailNeedsReconnect);
    const hint = `Ask the user to reconnect mail at ${ORIGIN}/settings/mail, then try again.`;
    expect(mail.message).toBe(`${MAIL_RECONNECT} ${hint}`);
    expect(mail.message).not.toContain('/connect');

    const moodle = toToolError(ctx, new NeedsReconnect('Expired.'));
    expect(moodle).not.toBeInstanceOf(MailNeedsReconnect);
    expect(moodle).toMatchObject({ code: 'needs_reconnect' });
    expect(moodle.message).toMatch(/^Expired\. Ask the user to sign in to Waseda Moodle in their browser/);
    expect(moodle.message).toContain(`reconnect at ${ORIGIN}/connect (paste the MoodleSession cookie)`);
  });

  it('adds the next step of the failing tool and keeps the error code', () => {
    const { ctx } = makeFakeContext({ publicUrl: ORIGIN });
    const e = toToolError(ctx, new MoodleError('Moodle could not find this item.', 'invalidrecord'), 'get_activity');
    expect(e).toMatchObject({ code: 'invalidrecord' });
    expect(e.message).toBe(
      'Moodle could not find this item. It may have been deleted, or the id is wrong: call get_course again and use an id it lists.',
    );
    const plain = new WmmError('nope', 'invalid_input');
    expect(toToolError(ctx, plain, 'get_activity')).toBe(plain);
  });

  it('answers through the tool result with the hint (registerTool passes its name)', async () => {
    const lost = defineTool({
      ...okTool,
      name: 'get_discussion',
      run: async () => {
        throw new MoodleError('Moodle could not find this item.', 'invalidrecord');
      },
    });
    const { ctx } = makeFakeContext({ publicUrl: ORIGIN });
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerTool(server, ctx, lost);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    open.push(client);
    const r = await client.callTool({ name: 'get_discussion', arguments: {} });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('call list_discussions again');
  });

  it('a busy Moodle session fails the tool at once with the wait-a-minute step', async () => {
    const rec = recorder();
    const { ctx, api } = makeFakeContext({ publicUrl: ORIGIN });
    // the worker's ctx.moodle() refuses while the session is marked busy (worker/context createMoodleClient)
    const busy = { ...ctx, usage: rec.usage, moodle: () => Promise.reject(new MoodleBusy(Date.now() + 60_000)) };
    const client = await connect(busy);
    const r = await client.callTool({ name: 'site', arguments: {} });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain(
      'Moodle is still working through earlier requests for this account. Try again in about a minute.',
    );
    expect(api.calls).toEqual([]);
    expect(rec.calls).toEqual([['site', 'moodle_unavailable']]);
  });

  it('keeps a message that already names its page', () => {
    const { ctx } = makeFakeContext({ publicUrl: ORIGIN });
    const mail = new MailNeedsReconnect(`Reconnect at ${ORIGIN}/settings/mail.`);
    expect(toToolError(ctx, mail)).toBe(mail);
    const moodle = new NeedsReconnect(`Reconnect at ${ORIGIN}/connect.`);
    expect(toToolError(ctx, moodle)).toBe(moodle);
  });
});
