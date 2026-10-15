import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerPrompts } from '../../src/core/mcp/prompts';
import { MAX_TEXT_CHARS } from '../../src/core/mcp/render/common';
import { renderSyllabus } from '../../src/core/mcp/render/syllabus';
import { registerTool } from '../../src/core/mcp/tools/register';
import { syllabusTools } from '../../src/core/mcp/tools/syllabus';
import { getSyllabusDetails, type SyllabusDetails } from '../../src/core/services/syllabus-details';
import { parseSyllabusPage } from '../../src/core/services/syllabus-page';
import { FREE_TEXT_PAGE, JA_PAGE } from '../fixtures/syllabus';
import { makeFakeContext } from '../helpers/fake-context';

vi.mock('../../src/core/services/syllabus-details', () => ({ getSyllabusDetails: vi.fn() }));

const SEARCH_URL = 'https://www.wsl.waseda.jp/syllabus/index.php';
const PAGE_URL = 'https://www.wsl.waseda.jp/syllabus/JAA104.php?pKey=5700100062022026570010006257&pLng=jp';

const jaPage = () => {
  const page = parseSyllabusPage(JA_PAGE, 'ja');
  if (!page) throw new Error('fixture does not parse');
  return page;
};

const details = (patch: Partial<SyllabusDetails> = {}): SyllabusDetails => ({
  courseId: 1,
  courseName: 'Course 1',
  status: 'ok',
  requestedLang: 'ja',
  page: jaPage(),
  url: PAGE_URL,
  searchUrl: SEARCH_URL,
  ...patch,
});

describe('renderSyllabus', () => {
  it('prints a digest: facts, grading first, then the plan, then the text parts', () => {
    const text = renderSyllabus(details());
    expect(text).toContain('Syllabus — Course 1 (course_id 1), updated 2026/05/15 12:37:49');
    expect(text).toContain('サンプル経営論 — 事例で学ぶ');
    expect(text).toContain('Term/period: 秋クォーター 水３-４');
    expect(text).toContain('Room: 99-101（教室）, 早稲田');
    expect(text).toContain('Instructors: 山田太郎, Sample Teacher');
    expect(text).toContain('Format: 【対面】');
    expect(text).toContain(`Public page: ${PAGE_URL}`);
    expect(text).toContain('- 試験 — 60% — 第14回に実施する。 持ち込み不可。');
    expect(text).toContain('- 平常点評価 — 40% — 毎回の小テスト。');
    expect(text).toContain('Plan (3 sessions):');
    expect(text).toContain('1. 第1回 ガイダンス — 授業の進め方 評価方法');
    expect(text).toContain('3. 第3回 事例研究');
    expect(text).toContain('Overview: 企業の戦略を学ぶ。 事例を使って議論する。');
    expect(text).toContain('Textbooks: 山田太郎『サンプル経営論』架空出版、2025年。');
    expect(text).toContain('focus=plan, grading, overview or materials');
    expect(text.indexOf('Grading')).toBeLessThan(text.indexOf('Plan ('));
    expect(text.indexOf('Plan (')).toBeLessThan(text.indexOf('Overview:'));
  });

  it('prints only the focused part, in full', () => {
    const grading = renderSyllabus(details(), 'grading');
    expect(grading).toContain('- 試験 — 60% — 第14回に実施する。 持ち込み不可。');
    expect(grading).not.toContain('Plan (');
    expect(grading).not.toContain('Overview');
    expect(grading).toContain('Other parts: focus=overview | plan | grading | materials.');

    const overview = renderSyllabus(details(), 'overview');
    expect(overview).toContain('Overview:\n企業の戦略を学ぶ。\n\n事例を使って議論する。');
    expect(overview).toContain('Goals:\n・戦略を説明できる\n・事例を分析できる');
    expect(overview).not.toContain('Grading');

    const materials = renderSyllabus(details(), 'materials');
    expect(materials).toContain('Notes:\n質問は授業後に受け付けます。 https://example.com/info');

    const plan = renderSyllabus(details(), 'plan');
    expect(plan).toContain('2. 第2回 戦略の基礎 — 競争優位');
    expect(plan).not.toContain('Grading');
  });

  it('prints free-text plan and grading', () => {
    const page = parseSyllabusPage(FREE_TEXT_PAGE, 'ja');
    const text = renderSyllabus(details({ page }));
    expect(text).toMatch(/Plan: 第1週\s*ガイダンス/);
    expect(text).toMatch(/Grading: レポート\s*40％/);
    expect(text).not.toContain('Plan (');
    expect(text).not.toContain('Instructors:');
  });

  it('stays within the output cap and says how much was left out', () => {
    const long = 'あ'.repeat(600);
    const base = jaPage();
    const page = {
      ...base,
      outline: long,
      objectives: long,
      prepost: long,
      textbooks: long,
      notes: long,
      sessions: Array.from({ length: 40 }, (_, i) => ({
        no: String(i + 1),
        title: `第${i + 1}回 ${long}`,
        body: long,
      })),
      grading: Array.from({ length: 8 }, (_, i) => ({ method: `評価${i}`, weight: 10, criteria: long })),
    };
    for (const focus of [undefined, 'plan', 'grading'] as const) {
      const text = renderSyllabus(details({ page }), focus);
      expect(text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS + 200);
      expect(text).toMatch(/… \d+ more \(/);
    }
  });

  it('says when the English page was not available', () => {
    expect(renderSyllabus(details({ requestedLang: 'en' }))).toContain(
      'English page not available; showing the Japanese one.',
    );
    expect(renderSyllabus(details())).not.toContain('English page not available');
  });

  it.each([
    ['not-a-class', 'not a regular class course'],
    ['no-page', 'no per-class page'],
    ['unavailable', 'did not answer'],
    ['disabled', 'switched off'],
  ] as const)('explains status %s and links the public search', (status, phrase) => {
    const text = renderSyllabus(details({ status, page: null, url: null }));
    expect(text).toContain('Syllabus — Course 1 (course_id 1)');
    expect(text).toContain(phrase);
    expect(text).toContain(SEARCH_URL);
    expect(text).not.toContain('Public page');
  });

  it('offers the page link of a failed fetch', () => {
    expect(renderSyllabus(details({ status: 'unavailable', page: null }))).toContain(PAGE_URL);
  });
});

// ------------------------------------------------------------------ tool + prompt over MCP

const open: Client[] = [];

async function connect(register: (server: McpServer) => void): Promise<Client> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  register(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  open.push(client);
  return client;
}

afterEach(async () => {
  vi.mocked(getSyllabusDetails).mockReset();
  await Promise.all(open.splice(0).map((c) => c.close()));
});

describe('get_syllabus tool', () => {
  const fake = makeFakeContext();
  const client = () =>
    connect((server) => {
      for (const def of syllabusTools) registerTool(server, fake.ctx, def);
    });

  it('is described, read-only and takes course_id with an optional focus', async () => {
    const tool = (await (await client()).listTools()).tools.find((t) => t.name === 'get_syllabus');
    expect(tool?.description?.length ?? 0).toBeGreaterThan(80);
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    const schema = tool?.inputSchema as {
      required?: string[];
      properties?: Record<string, { description?: string; enum?: string[] }>;
    };
    expect(schema.required).toEqual(['course_id']);
    expect(schema.properties?.course_id?.description).toBeTruthy();
    expect(schema.properties?.focus?.enum).toEqual(['overview', 'plan', 'grading', 'materials']);
    expect(schema.properties?.focus?.description).toBeTruthy();
  });

  it('returns the rendered text and the full details as structuredContent', async () => {
    vi.mocked(getSyllabusDetails).mockResolvedValue(details());
    const res = await (await client()).callTool({
      name: 'get_syllabus',
      arguments: { course_id: 1, focus: 'grading' },
    });
    const text = (res.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(text).toContain('- 試験 — 60%');
    expect(text).not.toContain('Plan (');
    expect(vi.mocked(getSyllabusDetails)).toHaveBeenCalledWith(expect.anything(), 1);
    const data = res.structuredContent as SyllabusDetails;
    expect(data).toMatchObject({ courseId: 1, status: 'ok', url: PAGE_URL });
    expect(data.page?.sessions).toHaveLength(3);
    expect(data.page?.grading.map((g) => g.weight)).toEqual([60, 40]);
  });

  it('rejects a missing course_id and an unknown focus', async () => {
    const c = await client();
    expect((await c.callTool({ name: 'get_syllabus', arguments: {} })).isError).toBe(true);
    expect((await c.callTool({ name: 'get_syllabus', arguments: { course_id: 1, focus: 'x' } })).isError).toBe(true);
    expect(vi.mocked(getSyllabusDetails)).not.toHaveBeenCalled();
  });
});

describe('exam_prep prompt', () => {
  const register = (server: McpServer) => registerPrompts(server, makeFakeContext().ctx);

  it('is listed next to the existing prompts, with a required course_id argument', async () => {
    const client = await connect(register);
    const prompts = (await client.listPrompts()).prompts;
    expect(prompts.map((p) => p.name).sort()).toEqual(['daily_briefing', 'exam_prep', 'weekly_plan']);
    const args = prompts.find((p) => p.name === 'exam_prep')?.arguments ?? [];
    expect(args).toHaveLength(1);
    expect(args[0]).toMatchObject({ name: 'course_id', required: true });
  });

  it('walks through get_syllabus, get_course and get_file for the given course', async () => {
    const client = await connect(register);
    const p = await client.getPrompt({ name: 'exam_prep', arguments: { course_id: '12' } });
    const text = (p.messages[0]?.content as { text?: string } | undefined)?.text ?? '';
    expect(text).toContain('get_syllabus with course_id=12');
    expect(text).toContain('get_course with course_id=12');
    expect(text).toContain('get_file');
    expect(text).toContain('focus=grading');
    expect(text).toMatch(/Do not submit, post or send/);
  });

  it('rejects a course_id that is not a number', async () => {
    const client = await connect(register);
    await expect(client.getPrompt({ name: 'exam_prep', arguments: { course_id: 'abc' } })).rejects.toThrow();
    await expect(client.getPrompt({ name: 'exam_prep' })).rejects.toThrow();
  });
});
