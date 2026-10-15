import type { CallToolResult, McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import type * as z from 'zod';
import type { ServiceContext } from '../../context';
import { NeedsReconnect, WmmError } from '../../errors';
import { RECONNECT_STDIO } from '../wording';
import type { ToolDef } from './define';

const asSchema = (s: z.ZodType) => s as unknown as StandardSchemaWithJSON;

/** Only plain, non-content values go to the audit log (never message text, file names or bytes). */
const AUDIT_STRING_KEYS = new Set(['forum_type', 'scope', 'upload_id', 'action_id', 'course_id']);

function auditDetail(args: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof args !== 'object' || args === null) return out;
  for (const [k, v] of Object.entries(args)) {
    const plain = typeof v === 'number' || typeof v === 'boolean';
    if (plain || (typeof v === 'string' && AUDIT_STRING_KEYS.has(k) && v.length <= 80)) out[k] = v;
  }
  return out;
}

/** WmmError messages are user-safe and pass through; anything else is replaced by a generic message. */
export function toToolError(ctx: ServiceContext, e: unknown): Error {
  if (e instanceof NeedsReconnect) {
    if (ctx.mode === 'stdio' || !ctx.publicUrl) return new NeedsReconnect(RECONNECT_STDIO);
    if (e.message.includes('/connect')) return e;
    return new NeedsReconnect(
      `${e.message.trimEnd()} Ask the user to reconnect at ${ctx.publicUrl}/connect, then try again.`,
    );
  }
  if (e instanceof WmmError) return e;
  console.error('[waseda-moodle] unexpected tool error:', e instanceof Error ? e.name : typeof e);
  return new WmmError(
    'Unexpected error while talking to Waseda Moodle. Try again; if it persists, tell the user.',
    'internal_error',
  );
}

/** `action` is the audit-log label, e.g. `tool:get_course`. */
export function audit(ctx: ServiceContext, action: string, args: unknown, error?: unknown): void {
  try {
    const detail = auditDetail(args);
    if (error !== undefined) detail.error = error instanceof WmmError ? error.code : 'internal_error';
    const row = { userId: ctx.user.id, at: Date.now(), actor: `mcp:${ctx.source}`, action, detail };
    ctx.defer(
      Promise.resolve()
        .then(() => ctx.store.audit(row))
        .catch(() => undefined),
    );
  } catch {
    /* best effort */
  }
}

/** Operator statistics: aggregate only, never allowed to affect the tool result. */
function countCall(ctx: ServiceContext, tool: string, ok: boolean): void {
  try {
    ctx.usage?.toolCall(tool, ok);
  } catch {
    /* best effort */
  }
}

/**
 * One tool invocation = one Moodle client: the first ctx.moodle() call is shared by every service call of the
 * invocation, so its call budget and memoised reads never leak into the next invocation (stdio is long-lived).
 */
export function callScoped(ctx: ServiceContext): ServiceContext {
  let api: ReturnType<ServiceContext['moodle']> | undefined;
  return {
    ...ctx,
    moodle: () => {
      api ??= ctx.moodle();
      return api;
    },
  };
}

export function registerTool(server: McpServer, ctx: ServiceContext, def: ToolDef): void {
  server.registerTool(
    def.name,
    {
      title: def.title,
      description: def.description,
      inputSchema: asSchema(def.input),
      outputSchema: asSchema(def.output),
      annotations: def.annotations,
    },
    async (raw: unknown): Promise<CallToolResult> => {
      const args = raw ?? {};
      try {
        const out = await def.run(callScoped(ctx), args);
        audit(ctx, `tool:${def.name}`, args);
        countCall(ctx, def.name, true);
        return {
          content: [{ type: 'text', text: out.text }, ...(out.extra ?? [])],
          structuredContent: out.data as Record<string, unknown>,
        };
      } catch (e) {
        audit(ctx, `tool:${def.name}`, args, e);
        countCall(ctx, def.name, false);
        throw toToolError(ctx, e);
      }
    },
  );
}
