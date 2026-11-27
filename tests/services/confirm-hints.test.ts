import { describe, expect, it } from 'vitest';
import { MoodleError, MoodleUnavailable } from '../../src/core/errors';
import { confirmAction } from '../../src/core/services/actions/confirm';
import { savePreview } from '../../src/core/services/actions/shared';
import { UNCERTAIN_MARK } from '../../src/core/services/actions/target';
import { makeFakeContext } from '../helpers/fake-context';

const COMPLETE = 'core_completion_update_activity_completion_status_manually';
const PAGE = 'https://wsdmoodle.waseda.jp/mod/page/view.php?id=7001';

async function failWith(error: Error, payload: Record<string, unknown> = { cmid: 7001, completed: true, url: PAGE }) {
  const scopes = ['moodle:read' as const, 'moodle:write' as const];
  const t = makeFakeContext({ scopes, responses: { core_course_get_recent_courses: [] } });
  Object.defineProperty(t.api, 'channel', { get: () => 'ws', configurable: true });
  const p = await savePreview(t.ctx, { kind: 'completion', title: 'Done', details: [], warnings: [], payload });
  t.api.set(COMPLETE, () => {
    throw error;
  });
  return confirmAction(t.ctx, p.actionId, 'mcp');
}

describe('failed writes tell what to do next', () => {
  it('an uncertain outcome: check the page on Moodle before retrying', async () => {
    const res = await failWith(new MoodleUnavailable());
    expect(res.status).toBe('failed');
    expect(res.message).toContain(UNCERTAIN_MARK);
    expect(res.message).toMatch(/before retrying\. https:\/\/wsdmoodle\.waseda\.jp\/mod\/page\/view\.php\?id=7001$/);
    expect(res.message).not.toContain('try again in a few minutes');
  });

  it("Moodle's validation message: correct it and prepare again", async () => {
    const res = await failWith(new MoodleError('件名は必須です。', 'validation'));
    expect(res.message).toBe('件名は必須です。 Correct it and prepare the action again.');
  });

  it('no permission: the teacher may have hidden it, check on Moodle', async () => {
    const refused = new MoodleError('Moodle refused access to this page.', 'nopermissions', '', { url: PAGE });
    const res = await failWith(refused);
    expect(res.message).toContain(`not enrolled in the course. Check it on Moodle: ${PAGE}`);
  });
});
