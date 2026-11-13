import { describe, expect, it } from 'vitest';
import { renderActivity } from '../../src/core/mcp/render/activity';
import { MAX_TEXT_CHARS } from '../../src/core/mcp/render/common';
import { parseQuestionnairePage } from '../../src/core/services/submission/questionnaire';
import type { QuestionnaireDetail } from '../../src/core/types';
import page1 from '../fixtures/questionnaire/respond-page1.json';
import page2 from '../fixtures/questionnaire/respond-page2.json';
import review from '../fixtures/questionnaire/review.json';

const base: QuestionnaireDetail = {
  type: 'questionnaire',
  cmid: 101,
  courseId: 99,
  courseName: '総合日本語３Ｘ',
  name: 'Session 3 report',
  url: 'https://moodle.example.com/mod/questionnaire/view.php?id=101',
  description: 'Please answer by Thursday.',
  opensAt: '2026-11-12T08:50:00+09:00',
  closesAt: '2026-11-19T13:00:00+09:00',
  window: 'open',
  status: 'none',
  submittedAt: null,
  submissions: 0,
  canAnswer: true,
  notice: null,
  answers: null,
  questions: [...parseQuestionnairePage(page1, 1).questions, ...parseQuestionnairePage(page2, 2).questions],
  complete: true,
};

describe('renderActivity (questionnaire)', () => {
  it('lists every question with the ids and choices an agent needs', () => {
    const text = renderActivity(base);
    expect(text).toContain('# Session 3 report — questionnaire (cmid 101)');
    expect(text).toContain('Opens: 2026-11-12 Thu 08:50 · Closes: 2026-11-19 Thu 13:00');
    expect(text).toContain('Status: not answered · open · can be answered now');
    expect(text).toContain('Questions (10 questions, 4 required):');
    expect(text).toContain('Page 1:');
    expect(text).toContain('Page 2:');
    expect(text).toContain('Q3 [single choice, required] (question_id 5003) Where do you usually study?');
    expect(text).toContain('  - 7003: Other: (+ text)');
    expect(text).toContain('  - 1: Yes');
    expect(text).toContain('Q7 [rating scale, required] (question_id 5007) Rate the lecture & the materials.');
    expect(text).toContain('  Scale: 1, 2, 3, 4, -1 = N/A');
    expect(text).toContain('  Range: 1–10 (step 1)');
    expect(text).toContain('To answer: prepare_questionnaire');
  });

  it('shows the submitted answers and why it cannot be answered', () => {
    const text = renderActivity({
      ...base,
      window: 'closed',
      status: 'submitted',
      submittedAt: '2026-11-18T11:11:00+09:00',
      submissions: 2,
      canAnswer: false,
      notice: 'Closed on Thursday, 19 November 2026, 1:00 PM.',
      answers: 'submitted',
      questions: parseQuestionnairePage(review, 1).questions,
    });
    expect(text).toContain('Status: answered 2026-11-18 Wed 11:11 (2 responses) · closed · cannot be answered now');
    expect(text).toContain('Moodle: Closed on Thursday, 19 November 2026, 1:00 PM.');
    expect(text).toContain('with the submitted answers');
    expect(text).toContain('  Answer: Other: Home');
    expect(text).not.toContain('Page 1:');
    expect(text).not.toContain('prepare_questionnaire');
  });

  it('explains an empty question list and unread pages', () => {
    const closed = renderActivity({ ...base, window: 'closed', canAnswer: false, questions: [] });
    expect(closed).toContain('Moodle shows the questions only while the questionnaire can be answered.');
    expect(closed).not.toContain('Questions (');
    const partial = renderActivity({ ...base, status: 'draft', answers: 'draft', complete: false });
    expect(partial).toContain('Status: draft saved, not submitted');
    expect(partial).toContain('with the saved draft');
    expect(partial).toContain('Some question pages could not be read');
    expect(partial).not.toContain('prepare_questionnaire');
  });

  it('stays within the text cap on a large form', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ ...base.questions[3]!, id: 6000 + i, number: String(i + 1) }));
    const text = renderActivity({ ...base, questions: many });
    expect(text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS + 200);
    expect(text).toMatch(/… \d+ more \(all questions are in the structured result\)/);
    expect(text).toContain('To answer: prepare_questionnaire');
  });
});
