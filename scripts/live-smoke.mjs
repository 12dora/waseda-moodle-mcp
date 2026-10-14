#!/usr/bin/env node
// Live smoke test against a deployed instance: node scripts/live-smoke.mjs
// Env: WMM_URL (e.g. https://wasemoodle.example.com), WMM_API_KEY (wmm_…). Read-only unless WMM_SMOKE_WRITE=1.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const base = process.env.WMM_URL;
const key = process.env.WMM_API_KEY;
if (!base || !key) {
  console.error('Set WMM_URL and WMM_API_KEY.');
  process.exit(2);
}

const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${key}` } },
});
const client = new Client({ name: 'wmm-live-smoke', version: '0.1.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.error(`tools: ${tools.map((t) => t.name).join(', ')}`);

async function call(name, args = {}) {
  const t0 = Date.now();
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.find((c) => c.type === 'text')?.text ?? '';
  console.error(`\n=== ${name} ${JSON.stringify(args)} — ${res.isError ? 'ERROR' : 'ok'} in ${Date.now() - t0} ms`);
  console.error(text.slice(0, Number(process.env.WMM_SMOKE_CHARS ?? 600)));
  return res;
}

const due = await call('get_due_items', {});
const courses = await call('list_courses', {});
const first = courses.structuredContent?.courses?.[0];
const assign = due.structuredContent?.items?.find((i) => i.kind === 'assign' && i.cmid);
if (first) {
  await call('get_course', { course_id: first.id });
  await call('get_grades', { course_id: first.id });
  await call('list_discussions', { course_id: first.id, limit: 5 });
}
if (assign) await call('get_activity', { cmid: assign.cmid });
await call('search_course_content', { query: 'report', limit: 5 });
await call('list_discussions', { limit: 5 });
await call('list_messages', { limit: 5 });
await call('list_notifications', { limit: 5 });
await call('get_grades', {});
await call('get_course_updates', {});
await client.close();
