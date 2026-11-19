/**
 * MCP surface: 31 tools + 4 mail tools when connected, 3 prompts and 2 resource templates over the service layer.
 * One McpServer per request (Worker) or per connection (stdio); tool definitions live in ./tools.
 */

import { McpServer } from '@modelcontextprotocol/server';
import type { ServiceContext } from '../context';
import { registerPrompts } from './prompts';
import { registerResources } from './resources';
import { courseTools } from './tools/courses';
import type { ToolDef } from './tools/define';
import { createUploadLinkTool, getFileTool } from './tools/files';
import { mailReadTools } from './tools/mail';
import { mailWriteTools } from './tools/mail-write';
import { myCoursesTools } from './tools/my-courses';
import { quizReviewTools } from './tools/quiz-review';
import { markReadTools } from './tools/read-state';
import { registerTool } from './tools/register';
import { scheduleTools } from './tools/schedule';
import { searchTools } from './tools/search';
import { socialTools } from './tools/social';
import { syllabusTools } from './tools/syllabus';
import { timetableTools } from './tools/timetable';
import { writeTools } from './tools/write';
import { serverInstructions } from './wording';

export const SERVER_VERSION = '0.1.0';

function access(ctx: ServiceContext) {
  const canWrite = ctx.scopes.includes('moodle:write');
  return {
    canWrite,
    canRead: canWrite || ctx.scopes.includes('moodle:read'),
    stdio: ctx.mode === 'stdio',
    mail: Boolean(ctx.mail),
  };
}

/** Read tools need moodle:read, write tools moodle:write (upload links: Worker only). */
function toolsFor({ canRead, canWrite, stdio, mail }: ReturnType<typeof access>): ToolDef[] {
  const tools: ToolDef[] = [];
  if (canRead) {
    tools.push(...courseTools, ...myCoursesTools, ...timetableTools, ...scheduleTools);
    tools.push(...syllabusTools, ...quizReviewTools);
    tools.push(getFileTool(stdio), ...socialTools, ...searchTools);
    if (mail) tools.push(...mailReadTools);
  }
  if (canWrite) {
    if (!stdio) tools.push(createUploadLinkTool);
    tools.push(...writeTools(stdio), ...markReadTools);
    if (mail) tools.push(...mailWriteTools);
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
  if (rights.canRead) {
    registerPrompts(server, ctx);
    registerResources(server, ctx);
  }
  return server;
}
