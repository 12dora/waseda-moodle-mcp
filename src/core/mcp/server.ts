/**
 * MCP surface: 23 tools + 2 prompts over the service layer.
 * One McpServer per request (Worker) or per connection (stdio); tool definitions live in ./tools.
 */

import { McpServer } from '@modelcontextprotocol/server';
import type { ServiceContext } from '../context';
import { registerPrompts } from './prompts';
import { courseTools } from './tools/courses';
import type { ToolDef } from './tools/define';
import { createUploadLinkTool, getFileTool } from './tools/files';
import { myCoursesTools } from './tools/my-courses';
import { registerTool } from './tools/register';
import { scheduleTools } from './tools/schedule';
import { socialTools } from './tools/social';
import { timetableTools } from './tools/timetable';
import { prepareSubmissionTool, writeTools } from './tools/write';
import { serverInstructions } from './wording';

export const SERVER_VERSION = '0.1.0';

function access(ctx: ServiceContext) {
  const canWrite = ctx.scopes.includes('moodle:write');
  return { canWrite, canRead: canWrite || ctx.scopes.includes('moodle:read'), stdio: ctx.mode === 'stdio' };
}

/** Read tools need moodle:read, write tools moodle:write (upload links: Worker only). */
function toolsFor({ canRead, canWrite, stdio }: ReturnType<typeof access>): ToolDef[] {
  const tools: ToolDef[] = [];
  if (canRead) {
    tools.push(...courseTools, ...myCoursesTools, ...timetableTools, ...scheduleTools);
    tools.push(getFileTool(stdio), ...socialTools);
  }
  if (canWrite) {
    if (!stdio) tools.push(createUploadLinkTool);
    tools.push(prepareSubmissionTool(stdio), ...writeTools);
  }
  return tools;
}

export function buildMcpServer(ctx: ServiceContext): McpServer {
  const server = new McpServer(
    { name: 'waseda-moodle', title: 'Waseda Moodle', version: SERVER_VERSION },
    { instructions: serverInstructions(ctx.mode) },
  );
  const rights = access(ctx);
  for (const def of toolsFor(rights)) registerTool(server, ctx, def);
  if (rights.canRead) registerPrompts(server);
  return server;
}
