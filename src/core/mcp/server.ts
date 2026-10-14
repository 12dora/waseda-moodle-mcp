/**
 * MCP surface: 19 tools + 2 prompts over the service layer.
 * One McpServer per request (Worker) or per connection (stdio); tool definitions live in ./tools.
 */

import { McpServer } from '@modelcontextprotocol/server';
import type { ServiceContext } from '../context';
import { registerPrompts } from './prompts';
import { courseTools } from './tools/courses';
import type { ToolDef } from './tools/define';
import { createUploadLinkTool, getFileTool } from './tools/files';
import { registerTool } from './tools/register';
import { socialTools } from './tools/social';
import { prepareSubmissionTool, writeTools } from './tools/write';

export const SERVER_VERSION = '0.1.0';

const INSTRUCTIONS = [
  'Waseda Moodle (https://wsdmoodle.waseda.jp) for one student: deadlines, course content, grades, forums, messages and, with permission, submissions.',
  'All times are JST. A deadline at 00:00 is shown as the previous day 24:00 (the real deadline is the end of that day).',
  'For "what is due / what should I do" call get_due_items first; use get_activity (cmid) for requirements, files and submission status.',
  'Files are never inlined by default: get_file returns a short-lived download link; fetch it with your own tools (e.g. curl) and read the file locally.',
  'Every write is two-step: prepare_* returns a preview, show it to the user, and call confirm_action only after the user clearly agrees. Never submit, post or send on your own initiative.',
  'Never take quizzes for the user; only report quiz dates and results.',
].join('\n');

function access(ctx: ServiceContext) {
  const canWrite = ctx.scopes.includes('moodle:write');
  return { canWrite, canRead: canWrite || ctx.scopes.includes('moodle:read'), stdio: ctx.mode === 'stdio' };
}

/** Read tools need moodle:read, write tools moodle:write (upload links: Worker only). */
function toolsFor({ canRead, canWrite, stdio }: ReturnType<typeof access>): ToolDef[] {
  const tools: ToolDef[] = [];
  if (canRead) tools.push(...courseTools, getFileTool, ...socialTools);
  if (canWrite) {
    if (!stdio) tools.push(createUploadLinkTool);
    tools.push(prepareSubmissionTool(stdio), ...writeTools);
  }
  return tools;
}

export function buildMcpServer(ctx: ServiceContext): McpServer {
  const server = new McpServer(
    { name: 'waseda-moodle', title: 'Waseda Moodle', version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );
  const rights = access(ctx);
  for (const def of toolsFor(rights)) registerTool(server, ctx, def);
  if (rights.canRead) registerPrompts(server);
  return server;
}
