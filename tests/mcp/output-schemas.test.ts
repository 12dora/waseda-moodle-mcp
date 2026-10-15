import { describe, expect, it } from 'vitest';
import { courseTools } from '../../src/core/mcp/tools/courses';
import type { ToolDef } from '../../src/core/mcp/tools/define';
import { createUploadLinkTool, getFileTool } from '../../src/core/mcp/tools/files';
import { myCoursesTools } from '../../src/core/mcp/tools/my-courses';
import { quizReviewTools } from '../../src/core/mcp/tools/quiz-review';
import { markReadTools } from '../../src/core/mcp/tools/read-state';
import { scheduleTools } from '../../src/core/mcp/tools/schedule';
import { searchTools } from '../../src/core/mcp/tools/search';
import { socialTools } from '../../src/core/mcp/tools/social';
import { syllabusTools } from '../../src/core/mcp/tools/syllabus';
import { timetableTools } from '../../src/core/mcp/tools/timetable';
import { prepareSubmissionTool, writeTools } from '../../src/core/mcp/tools/write';
import { OUTPUT_SAMPLES } from '../fixtures/output-samples';

const TOOLS: ToolDef[] = [
  ...courseTools,
  ...myCoursesTools,
  ...timetableTools,
  ...scheduleTools,
  ...syllabusTools,
  ...quizReviewTools,
  getFileTool(false),
  ...socialTools,
  ...searchTools,
  createUploadLinkTool,
  prepareSubmissionTool(false),
  ...writeTools,
  ...markReadTools,
];

const outputOf = (name: string) => {
  const def = TOOLS.find((t) => t.name === name);
  if (!def) throw new Error(`no tool ${name}`);
  return def.output;
};

describe('tool output schemas', () => {
  it('every tool has an output schema and a sample payload, and nothing else has a sample', () => {
    const names = TOOLS.map((t) => t.name).sort();
    expect(names).toHaveLength(29);
    expect(Object.keys(OUTPUT_SAMPLES).sort()).toEqual(names);
  });

  it.each(Object.entries(OUTPUT_SAMPLES))('%s accepts its payloads, also after a JSON round trip', (name, samples) => {
    expect(samples.length).toBeGreaterThanOrEqual(1);
    for (const sample of samples) {
      for (const payload of [sample, JSON.parse(JSON.stringify(sample))]) {
        const res = outputOf(name).safeParse(payload);
        expect(res.success, JSON.stringify(res.error?.issues)).toBe(true);
      }
    }
  });

  it('accepts extra keys the schema does not know (permissive on purpose)', () => {
    const [sample] = OUTPUT_SAMPLES.get_due_items ?? [];
    expect(outputOf('get_due_items').safeParse({ ...sample, futureField: 1 }).success).toBe(true);
  });

  it.each([
    ['get_due_items', { items: 'not a list' }],
    ['list_courses', {}],
    ['prepare_message', { actionId: 'a' }],
    ['confirm_action', { actionId: 'a', status: 1, message: 'x' }],
    ['get_syllabus', null],
  ])('%s rejects a payload of the wrong shape', (name, payload) => {
    expect(outputOf(name).safeParse(payload).success).toBe(false);
  });
});
