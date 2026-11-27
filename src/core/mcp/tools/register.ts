import type { CallToolResult, McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import type * as z from 'zod';
import type { ServiceContext } from '../../context';
import { MailNeedsReconnect, WmmError } from '../../errors';
import { type FailureClass, failureClass } from '../../usage';
import { explainError } from '../error-hints';
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

/**
 * The error a tool (or resource) call answers with: WmmError messages are user-safe and get their next step
 * (error-hints); anything else is replaced by a generic message.
 */
export function toToolError(ctx: ServiceContext, e: unknown, tool?: string): Error {
  if (e instanceof WmmError) {
    const message = explainError(e, { mode: ctx.mode, publicUrl: ctx.publicUrl, tool });
    if (message === e.message) return e;
    return e instanceof MailNeedsReconnect ? new MailNeedsReconnect(message) : new WmmError(message, e.code);
  }
  console.error('[waseda-moodle] unexpected tool error:', e instanceof Error ? e.name : typeof e);
  return new WmmError(
    'Unexpected error while talking to Waseda Moodle. Try again; if it keeps happening, tell the user.',
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
function countCall(ctx: ServiceContext, tool: string, started: number, failure: FailureClass | null): void {
  try {
    ctx.usage?.toolCall({ tool, ms: Date.now() - started, failure });
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
      const started = Date.now();
      try {
        const out = await def.run(callScoped(ctx), args);
        audit(ctx, `tool:${def.name}`, args);
        countCall(ctx, def.name, started, null);
        return {
          content: [{ type: 'text', text: out.text }, ...(out.extra ?? [])],
          structuredContent: out.data as Record<string, unknown>,
        };
      } catch (e) {
        audit(ctx, `tool:${def.name}`, args, e);
        countCall(ctx, def.name, started, failureClass(e));
        throw toToolError(ctx, e, def.name);
      }
    },
  );
}
