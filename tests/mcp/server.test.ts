import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '../../src/core/context';
import { MoodleError, NeedsReconnect } from '../../src/core/errors';
import { buildMcpServer } from '../../src/core/mcp/server';
import { callScoped } from '../../src/core/mcp/tools/register';
import {
  cancelAction,
  confirmAction,
  prepareCompletion,
  prepareForumPost,
  prepareMessage,
  prepareSubmission,
} from '../../src/core/services/actions';
import { createFileLink } from '../../src/core/services/files';
import type { Scope } from '../../src/core/types';
import { type FakeContextOptions, makeFakeContext } from '../helpers/fake-context';

vi.mock('../../src/core/services/actions', () => ({
  prepareSubmission: vi.fn(),
  prepareForumPost: vi.fn(),
  prepareMessage: vi.fn(),
  prepareCompletion: vi.fn(),
  confirmAction: vi.fn(),
  cancelAction: vi.fn(),
}));
vi.mock('../../src/core/services/files', () => ({
  createFileLink: vi.fn(),
  createUploadLink: vi.fn(),
}));

const READ: Scope[] = ['moodle:read'];
const WRITE: Scope[] = ['moodle:read', 'moodle:write'];

const READ_TOOLS = [
  'get_due_items',
  'list_courses',
  'get_course',
  'search_course_content',
  'get_activity',
  'get_file',
  'get_grades',
  'list_discussions',
  'get_discussion',
  'list_messages',
  'get_conversation',
  'list_notifications',
];
const WRITE_TOOLS = [
  'prepare_submission',
  'prepare_forum_post',
  'prepare_message',
  'prepare_completion',
  'confirm_action',
  'cancel_action',
];

const open: Array<{ client: Client; server: McpServer }> = [];

async function connect(ctx: ServiceContext) {
  const server = buildMcpServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  open.push({ client, server });
  return client;
}

function fake(opts: FakeContextOptions = {}) {
  return makeFakeContext({ scopes: READ, ...opts });
}

const textOf = (r: { content?: unknown }) => {
  const first = (r.content as Array<{ type: string; text?: string }>)[0];
  return first?.text ?? '';
};

type SchemaProps = Record<string, { items?: { properties?: Record<string, unknown> } }>;

function submissionProps(tools: Array<{ name: string; inputSchema: unknown }>): SchemaProps {
  const sub = tools.find((t) => t.name === 'prepare_submission');
  return (sub?.inputSchema as { properties?: SchemaProps } | undefined)?.properties ?? {};
}

/** Tools receive a per-invocation copy of the context; match it by its user. */
const sameUser = (ctx: ServiceContext) => expect.objectContaining({ user: ctx.user });

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(async () => {
  for (const { client, server } of open.splice(0)) {
    await client.close();
    await server.close();
  }
});

describe('tool registration', () => {
  it('registers read tools only for a read scope', async () => {
    const client = await connect(fake().ctx);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...READ_TOOLS].sort());
  });

  it('adds write tools and create_upload_link for write scope in worker mode (19 tools)', async () => {
    const client = await connect(fake({ scopes: WRITE }).ctx);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...READ_TOOLS, ...WRITE_TOOLS, 'create_upload_link'].sort());
    expect(names).toHaveLength(19);
  });

  it('drops create_upload_link in stdio mode and offers local paths instead of upload ids', async () => {
    const client = await connect(fake({ scopes: WRITE, mode: 'stdio', publicUrl: '' }).ctx);
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name)).not.toContain('create_upload_link');
    expect(tools).toHaveLength(18);
    const props = submissionProps(tools);
    expect(props.upload_id).toBeUndefined();
    expect(props.files?.items?.properties?.path).toBeDefined();
  });

  it('keeps path out of the worker schema and offers upload_id', async () => {
    const client = await connect(fake({ scopes: WRITE }).ctx);
    const props = submissionProps((await client.listTools()).tools);
    expect(props.upload_id).toBeDefined();
    expect(props.files?.items?.properties?.path).toBeUndefined();
  });

  it('describes every tool and every input field, and sets annotations', async () => {
    const client = await connect(fake({ scopes: WRITE }).ctx);
    const tools = (await client.listTools()).tools;
    for (const t of tools) {
      expect(t.description?.length ?? 0, t.name).toBeGreaterThan(80);
      const props = (t.inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {};
      for (const [k, v] of Object.entries(props)) expect(v.description, `${t.name}.${k}`).toBeTruthy();
    }
    const by = new Map(tools.map((t) => [t.name, t]));
    expect(by.get('get_due_items')?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(by.get('prepare_message')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(by.get('confirm_action')?.annotations).toMatchObject({ destructiveHint: true });
    expect(by.get('cancel_action')?.annotations).toMatchObject({ destructiveHint: false, idempotentHint: true });
  });

  it('serves instructions and the two prompts', async () => {
    const client = await connect(fake().ctx);
    expect(client.getServerVersion()).toMatchObject({ name: 'waseda-moodle', title: 'Waseda Moodle' });
    expect(client.getInstructions()).toMatch(/JST/);
    expect(client.getInstructions()).toMatch(/confirm_action/);
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
    expect(prompts).toEqual(['daily_briefing', 'weekly_plan']);
    const p = await client.getPrompt({ name: 'daily_briefing' });
    const text = (p.messages[0]?.content as { text?: string } | undefined)?.text ?? '';
    expect(text).toContain('get_due_items');
    expect(text).toContain('list_notifications');
  });
});

describe('read tools', () => {
  const eventAt = Math.floor(Date.now() / 1000) + 3 * 3600;
  const responses = {
    core_calendar_get_action_events_by_timesort: {
      events: [
        {
          id: 1,
          name: 'Report 3 is due',
          activityname: 'Report 3',
          eventtype: 'due',
          modulename: 'assign',
          instance: 15,
          timesort: eventAt,
          course: { id: 101, fullname: 'Finance &amp; Accounting' },
          url: 'https://moodle.example.edu/mod/assign/view.php?id=5001',
          action: { name: 'Add submission' },
        },
      ],
    },
  };

  it('returns markdown text plus structuredContent, and audits the call', async () => {
    const f = fake({ responses });
    const client = await connect(f.ctx);
    const r = await client.callTool({ name: 'get_due_items', arguments: { days_ahead: 7 } });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('[assign] Report 3');
    expect(textOf(r)).toContain('Finance & Accounting');
    expect(textOf(r)).toContain('(cmid 5001)');
    const sc = r.structuredContent as { items: Array<{ name: string; cmid: number }> };
    expect(sc.items[0]).toMatchObject({ name: 'Report 3', cmid: 5001 });
    const params = f.api.calls[0]?.params as { timesortto: number };
    expect(params.timesortto - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(7 * 86400 + 5);

    await Promise.all(f.deferred);
    expect(f.state.audit).toHaveLength(1);
    expect(f.state.audit[0]).toMatchObject({
      userId: f.ctx.user.id,
      action: 'tool:get_due_items',
      actor: 'mcp:Test',
      detail: { days_ahead: 7 },
    });
  });

  it('wraps list results in an object for structuredContent', async () => {
    const f = fake({
      responses: {
        core_course_get_enrolled_courses_by_timeline_classification: {
          courses: [
            {
              id: 101,
              fullname: 'Finance',
              shortname: 'F',
              viewurl: 'https://moodle.example.edu/course/view.php?id=101',
              progress: 40,
            },
          ],
        },
      },
    });
    const client = await connect(f.ctx);
    const r = await client.callTool({ name: 'list_courses', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { courses: Array<{ id: number }> }).courses[0]?.id).toBe(101);
    expect(textOf(r)).toContain('course_id 101');
  });

  it('turns schema violations into isError results', async () => {
    const client = await connect(fake({ responses }).ctx);
    const r = await client.callTool({ name: 'get_due_items', arguments: { days_ahead: 'soon' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/days_ahead/);
  });

  it('passes WmmError messages through as isError and audits the failure', async () => {
    const f = fake({
      responses: { core_calendar_get_action_events_by_timesort: new MoodleError('Calendar disabled', 'nocalendar') },
    });
    const client = await connect(f.ctx);
    const r = await client.callTool({ name: 'get_due_items', arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe('Calendar disabled');
    await Promise.all(f.deferred);
    expect(f.state.audit[0]?.detail).toMatchObject({ error: 'nocalendar' });
  });

  it('hides unexpected error details', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const f = fake({
      responses: {
        core_calendar_get_action_events_by_timesort: () => {
          throw new TypeError('secret internals');
        },
      },
    });
    const client = await connect(f.ctx);
    const r = await client.callTool({ name: 'get_due_items', arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).not.toContain('secret internals');
    spy.mockRestore();
  });

  it('adds the connect URL to NeedsReconnect (worker)', async () => {
    const f = fake();
    f.ctx.moodle = async () => {
      throw new NeedsReconnect();
    };
    const client = await connect(f.ctx);
    const r = await client.callTool({ name: 'get_due_items', arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('https://wasemoodle.example.com/connect');
  });

  it('adds the CLI hint to NeedsReconnect (stdio)', async () => {
    const f = fake({ mode: 'stdio', publicUrl: '' });
    f.ctx.moodle = async () => {
      throw new NeedsReconnect('Token expired.');
    };
    const client = await connect(f.ctx);
    const r = await client.callTool({ name: 'list_courses', arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).not.toContain('Token expired.'); // replaced, not appended
    expect(textOf(r)).toContain('waseda-moodle-mcp connect');
    expect(textOf(r)).not.toContain('console');
  });

  it('does not let a failing audit break the tool', async () => {
    const f = fake({ responses });
    f.ctx.store.audit = async () => {
      throw new Error('db down');
    };
    const client = await connect(f.ctx);
    const r = await client.callTool({ name: 'get_due_items', arguments: {} });
    expect(r.isError).toBeFalsy();
    await expect(Promise.all(f.deferred)).resolves.toBeDefined();
  });

  it('get_file adds a resource_link and embeds small inline content once', async () => {
    vi.mocked(createFileLink).mockResolvedValue({
      name: 'notes.txt',
      mime: 'text/plain',
      size: 5,
      downloadUrl: 'https://wasemoodle.example.com/f/tkt',
      expiresAt: '2026-10-14T12:15:00+09:00',
      inline: { mime: 'text/plain', text: 'hello' },
    });
    const f = fake();
    const client = await connect(f.ctx);
    const r = await client.callTool({
      name: 'get_file',
      arguments: { url: 'https://moodle.example.edu/webservice/pluginfile.php/1/notes.txt', inline: true },
    });
    expect(r.isError).toBeFalsy();
    expect(createFileLink).toHaveBeenCalledWith(sameUser(f.ctx), expect.stringContaining('notes.txt'), {
      inline: true,
    });
    const types = (r.content as Array<{ type: string }>).map((c) => c.type);
    expect(types).toEqual(['text', 'resource_link', 'resource']);
    expect(textOf(r)).toContain('curl');
    expect(r.structuredContent).toMatchObject({ name: 'notes.txt', inline: { mime: 'text/plain', attached: true } });
    expect(JSON.stringify(r.structuredContent)).not.toContain('hello');
  });

  it('get_file sends only png/jpeg/gif/webp as image blocks; other images are binary resources', async () => {
    const link = (mime: string) => ({
      name: 'fig',
      mime,
      size: 3,
      downloadUrl: 'https://wasemoodle.example.com/f/t',
      expiresAt: '2026-10-14T12:15:00+09:00',
      inline: { mime, base64: 'AAEC' },
    });
    const client = await connect(fake().ctx);
    const call = async (mime: string) => {
      vi.mocked(createFileLink).mockResolvedValue(link(mime));
      const r = await client.callTool({
        name: 'get_file',
        arguments: { url: 'https://moodle.example.edu/x', inline: true },
      });
      return (r.content as Array<{ type: string; data?: string; mimeType?: string; resource?: { blob?: string } }>)[2];
    };
    for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      expect(await call(mime), mime).toMatchObject({ type: 'image', data: 'AAEC', mimeType: mime });
    }
    for (const mime of ['image/svg+xml', 'image/tiff', 'image/bmp']) {
      expect(await call(mime), mime).toMatchObject({ type: 'resource', resource: { mimeType: mime, blob: 'AAEC' } });
    }
  });

  it('describes get_file for the mode', async () => {
    const worker = await connect(fake().ctx);
    const workerTool = (await worker.listTools()).tools.find((t) => t.name === 'get_file');
    expect(workerTool?.description).toMatch(/download link/);
    const local = await connect(fake({ mode: 'stdio', publicUrl: '' }).ctx);
    const localTool = (await local.listTools()).tools.find((t) => t.name === 'get_file');
    expect(localTool?.description).toMatch(/temporary local file/);
    expect(local.getInstructions()).toMatch(/temporary local path/);
    expect(worker.getInstructions()).toMatch(/curl/);
  });
});

describe('per-invocation Moodle client', () => {
  it('callScoped hands every service call of one invocation the same client', async () => {
    const f = fake();
    let created = 0;
    f.ctx.moodle = async () => {
      created++;
      return f.api;
    };
    const first = callScoped(f.ctx);
    expect(await first.moodle()).toBe(await first.moodle());
    expect(created).toBe(1);
    await callScoped(f.ctx).moodle();
    expect(created).toBe(2);
  });

  it('a tool call asks the context for one client per invocation', async () => {
    const f = fake({ responses: { core_course_get_contents: [] } });
    let created = 0;
    const original = f.ctx.moodle;
    f.ctx.moodle = async () => {
      created++;
      return original();
    };
    const client = await connect(f.ctx);
    await client.callTool({ name: 'list_courses', arguments: {} }).catch(() => undefined);
    await client.callTool({ name: 'list_courses', arguments: {} }).catch(() => undefined);
    expect(created).toBe(2);
  });
});

describe('write tools', () => {
  const preview = {
    actionId: 'act_1',
    kind: 'message' as const,
    title: 'Send a message to Prof. Sato',
    details: ['Text: Hello'],
    warnings: [],
    expiresAt: '2026-10-14T12:30:00+09:00',
    approval: 'chat' as const,
    approveUrl: null,
  };

  it('prepare_* maps snake_case input and renders the confirm instruction', async () => {
    vi.mocked(prepareMessage).mockResolvedValue(preview);
    const f = fake({ scopes: WRITE });
    const client = await connect(f.ctx);
    const r = await client.callTool({ name: 'prepare_message', arguments: { conversation_id: 12, text: 'Hello' } });
    expect(r.isError).toBeFalsy();
    expect(prepareMessage).toHaveBeenCalledWith(sameUser(f.ctx), {
      conversationId: 12,
      toUserId: undefined,
      text: 'Hello',
    });
    expect(textOf(r)).toContain('Call confirm_action with action_id "act_1" only after they agree');
    expect(r.structuredContent).toMatchObject({ actionId: 'act_1', approval: 'chat' });

    await Promise.all(f.deferred);
    // message text never reaches the audit log
    expect(JSON.stringify(f.state.audit)).not.toContain('Hello');
    expect(f.state.audit[0]?.action).toBe('tool:prepare_message');
  });

  it('prepare_submission maps files and flags', async () => {
    vi.mocked(prepareSubmission).mockResolvedValue({ ...preview, kind: 'assign_submit' });
    const f = fake({ scopes: WRITE });
    const client = await connect(f.ctx);
    await client.callTool({
      name: 'prepare_submission',
      arguments: {
        cmid: 5001,
        online_text: 'Answer',
        files: [
          { name: 'a.txt', text: 'x' },
          { name: 'b.bin', content_base64: 'AAE=' },
        ],
        upload_id: 'upl_1',
        keep_existing_files: false,
        submit_for_grading: false,
        accept_statement: true,
      },
    });
    expect(prepareSubmission).toHaveBeenCalledWith(sameUser(f.ctx), {
      cmid: 5001,
      onlineText: 'Answer',
      files: [
        { name: 'a.txt', text: 'x' },
        { name: 'b.bin', contentBase64: 'AAE=' },
      ],
      uploadId: 'upl_1',
      keepExistingFiles: false,
      submitForGrading: false,
      acceptStatement: true,
    });
  });

  it('prepare_forum_post and prepare_completion map their input', async () => {
    vi.mocked(prepareForumPost).mockResolvedValue({ ...preview, kind: 'forum_reply' });
    vi.mocked(prepareCompletion).mockResolvedValue({ ...preview, kind: 'completion' });
    const f = fake({ scopes: WRITE });
    const client = await connect(f.ctx);
    await client.callTool({
      name: 'prepare_forum_post',
      arguments: { forum_type: 'hsuforum', reply_to_post_id: 7, message: 'Thanks' },
    });
    expect(prepareForumPost).toHaveBeenCalledWith(sameUser(f.ctx), {
      forumType: 'hsuforum',
      replyToPostId: 7,
      forumId: undefined,
      subject: undefined,
      message: 'Thanks',
    });
    await client.callTool({ name: 'prepare_completion', arguments: { cmid: 9, completed: true } });
    expect(prepareCompletion).toHaveBeenCalledWith(sameUser(f.ctx), { cmid: 9, completed: true });
  });

  it('confirm_action calls the service via mcp; cancel_action cancels', async () => {
    vi.mocked(confirmAction).mockResolvedValue({
      actionId: 'act_1',
      status: 'executed',
      message: 'Message sent.',
      url: null,
    });
    vi.mocked(cancelAction).mockResolvedValue({
      actionId: 'act_2',
      status: 'cancelled',
      message: 'Cancelled.',
      url: null,
    });
    const f = fake({ scopes: WRITE });
    const client = await connect(f.ctx);
    const ok = await client.callTool({ name: 'confirm_action', arguments: { action_id: 'act_1' } });
    expect(confirmAction).toHaveBeenCalledWith(sameUser(f.ctx), 'act_1', 'mcp');
    expect(textOf(ok)).toBe('Action act_1: executed. Message sent.');
    expect(ok.structuredContent).toMatchObject({ status: 'executed' });
    const no = await client.callTool({ name: 'cancel_action', arguments: { action_id: 'act_2' } });
    expect(cancelAction).toHaveBeenCalledWith(sameUser(f.ctx), 'act_2');
    expect(textOf(no)).toContain('cancelled');
  });

  it('surfaces service errors (e.g. console approval required) as isError', async () => {
    const { Forbidden } = await import('../../src/core/errors');
    vi.mocked(confirmAction).mockRejectedValue(
      new Forbidden('Approve this action in the console: https://wasemoodle.example.com/actions?focus=act_1'),
    );
    const client = await connect(fake({ scopes: WRITE }).ctx);
    const r = await client.callTool({ name: 'confirm_action', arguments: { action_id: 'act_1' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Approve this action in the console');
  });

  it('does not expose write tools to read-only callers', async () => {
    const client = await connect(fake().ctx);
    await expect(client.callTool({ name: 'confirm_action', arguments: { action_id: 'act_1' } })).rejects.toThrow();
    expect(confirmAction).not.toHaveBeenCalled();
  });
});
