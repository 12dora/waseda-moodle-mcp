import { describe, expect, it } from 'vitest';
import { prepareCompletion } from '../../src/core/services/actions/completion';
import { createTestContext } from '../helpers/fake-context-be4';
import { makeWebApi, type WebApiOptions } from './web-channel';

/** The course-page snippet of one activity (core_course_get_module), as Moodle 5 renders it. */
const snippet = (toggle: string | null) => `<li class="activity resource modtype_resource" id="module-7001"
 data-for="cmitem" data-id="7001"><div class="activity-item" data-activityname="資料１">
<a href="https://wsdmoodle.waseda.jp/mod/resource/view.php?id=7001" class="aalink stretched-link">資料１</a>
${
  toggle === null
    ? ''
    : `<div data-region="completion-info"><button class="btn btn-subtle-body btn-sm"
 data-action="toggle-manual-completion" data-toggletype="${toggle}" data-cmid="7001">完了マークする</button></div>`
}
</div></li>`;

function setup(opts: WebApiOptions) {
  const api = makeWebApi(opts);
  const { ctx } = createTestContext();
  return { api, ctx: { ...ctx, moodle: async () => api } };
}

describe('prepareCompletion on the web channel', () => {
  it('reads the state from the activity snippet and never opens the activity page (a view would mark it done)', async () => {
    const { api, ctx } = setup({ ajax: { core_course_get_module: snippet('manual:mark-done') } });
    const preview = await prepareCompletion(ctx, { cmid: 7001, completed: true });
    expect(preview.details).toEqual(['Activity: 資料１', 'Mark as: complete']);
    expect(preview.warnings).toEqual([]);
    expect(api.pageCalls.filter((c) => c.startsWith('GET'))).toEqual([]);
    expect(api.calls).toEqual([]);
  });

  it('warns when the state is already the requested one; refuses without manual tracking', async () => {
    const done = setup({ ajax: { core_course_get_module: snippet('manual:undo') } });
    expect((await prepareCompletion(done.ctx, { cmid: 7001, completed: true })).warnings).toContain(
      'It is already marked complete.',
    );
    const none = setup({ ajax: { core_course_get_module: snippet(null) } });
    await expect(prepareCompletion(none.ctx, { cmid: 7001, completed: true })).rejects.toThrow(
      'no completion tracking',
    );
  });
});
