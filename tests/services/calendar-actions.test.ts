import { describe, expect, it } from 'vitest';
import { MoodleError, NotFound } from '../../src/core/errors';
import { renderCalendarEvents } from '../../src/core/mcp/render/calendar';
import { confirmAction, prepareCalendarEvent } from '../../src/core/services/actions';
import { executeCalendarEventEdit } from '../../src/core/services/actions/calendar';
import { parseEventTime } from '../../src/core/services/actions/calendar-form';
import { listCalendarEvents } from '../../src/core/services/calendar';
import { createTestContext } from '../helpers/fake-context-be4';
import { makeWebApi, type WebApiOptions } from './web-channel';

/** Invented data only. The fake web session's user is 7001. */
const USER = 7001;
const START = Date.parse('2030-12-02T10:30:00+09:00') / 1000;
const HOUR = 3600;
const DAY = 86_400;

type Args = Record<string, unknown>;

function webSetup(opts: WebApiOptions) {
  const api = makeWebApi(opts);
  const { ctx } = createTestContext();
  return { api, ctx: { ...ctx, moodle: async () => api } };
}

const personal = (over: Args = {}) => ({
  id: 5101,
  name: '面談 &amp; 準備',
  eventtype: 'user',
  userid: USER,
  courseid: 0,
  timestart: START,
  timeduration: HOUR,
  description: '<p>研究室</p>',
  location: '',
  canedit: true,
  candelete: true,
  ...over,
});

/** An ajax answer that records its args. */
function recorder(answer: unknown) {
  const sent: Args[] = [];
  const fn = (args: Args) => {
    sent.push(args);
    return answer;
  };
  return { sent, fn };
}

const formOf = (args: Args | undefined) => new URLSearchParams(String(args?.formdata ?? ''));

describe('prepare_calendar_event create (web channel)', () => {
  it('previews without contacting Moodle and saves through the event form with JST date parts', async () => {
    const submit = recorder({ event: { id: 5201, timestart: START }, validationerror: false });
    const { api, ctx } = webSetup({ ajax: { core_calendar_submit_create_update_form: submit.fn } });
    const preview = await prepareCalendarEvent(ctx, {
      action: 'create',
      name: 'ゼミ準備',
      start: '2030-12-02T10:30',
      durationMinutes: 90,
      description: 'Room 3\nbring notes',
    });
    expect(preview).toMatchObject({ kind: 'calendar_event_create', title: "Create calendar event 'ゼミ準備'" });
    expect(preview.details).toEqual([
      'Name: ゼミ準備',
      'When: 2030-12-02 Mon 10:30 – 2030-12-02 Mon 12:00 JST',
      'Description: Room 3 bring notes',
      'Type: personal event (only you can see it)',
    ]);
    expect(preview.warnings).toEqual([]);
    expect(api.pageCalls).toEqual([]);

    const result = await confirmAction(ctx, preview.actionId, 'mcp');
    expect(result).toMatchObject({
      status: 'executed',
      message: "Created calendar event 'ゼミ準備' (event_id 5201).",
      url: `https://wsdmoodle.waseda.jp/calendar/view.php?view=day&time=${START}`,
    });
    expect(submit.sent).toHaveLength(1);
    const form = formOf(submit.sent[0]);
    expect(Object.fromEntries([...form.entries()].filter(([k]) => k !== 'description[itemid]'))).toEqual({
      id: '0',
      userid: String(USER),
      modulename: '',
      instance: '0',
      visible: '1',
      sesskey: 'fakesesskey01',
      _qf__core_calendar_local_event_forms_create: '1',
      mform_isexpanded_id_general: '1',
      name: 'ゼミ準備',
      'timestart[day]': '2',
      'timestart[month]': '12',
      'timestart[year]': '2030',
      'timestart[hour]': '10',
      'timestart[minute]': '30',
      eventtype: 'user',
      'description[text]': 'Room 3<br>bring notes',
      'description[format]': '1',
      location: '',
      duration: '1',
      'timedurationuntil[day]': '2',
      'timedurationuntil[month]': '12',
      'timedurationuntil[year]': '2030',
      'timedurationuntil[hour]': '12',
      'timedurationuntil[minute]': '0',
      repeat: '0',
    });
    expect(Number(form.get('description[itemid]'))).toBeGreaterThan(0);
  });

  it('sends no duration without end; notes a start Moodle stored in another time zone', async () => {
    const submit = recorder({ event: { id: 5202, timestart: START + HOUR }, validationerror: false });
    const { ctx } = webSetup({ ajax: { core_calendar_submit_create_update_form: submit.fn } });
    const preview = await prepareCalendarEvent(ctx, { action: 'create', name: '提出', start: '2030-12-02T10:30' });
    expect(preview.details[1]).toBe('When: 2030-12-02 Mon 10:30 JST (no end time)');
    const result = await confirmAction(ctx, preview.actionId, 'mcp');
    expect(formOf(submit.sent[0]).get('duration')).toBe('0');
    expect(formOf(submit.sent[0]).has('timedurationuntil[day]')).toBe(false);
    expect(result.message).toContain('Moodle stored the start as 2030-12-02 Mon 11:30 JST');
  });

  it('fails the action when the form reports a validation error (sent once: the sesskey did not change)', async () => {
    const submit = recorder({ validationerror: true });
    const { ctx } = webSetup({ ajax: { core_calendar_submit_create_update_form: submit.fn } });
    const preview = await prepareCalendarEvent(ctx, { action: 'create', name: 'x', start: '2030-12-02T10:30' });
    const result = await confirmAction(ctx, preview.actionId, 'mcp');
    expect(result.status).toBe('failed');
    expect(result.message).toContain('Moodle did not accept the event');
    expect(submit.sent).toHaveLength(1);
  });

  it('rebuilds the form with the renewed sesskey when the session renewed a stale one while sending', async () => {
    let key = 'fakesesskey01';
    const sent: Args[] = [];
    const { api, ctx } = webSetup({
      ajax: {
        core_calendar_submit_create_update_form: (args: Args) => {
          sent.push(args);
          // the session renewed the key on invalidsesskey; the form inside still carried the old one
          if (sent.length > 1) return { event: { id: 5203, timestart: START }, validationerror: false };
          key = 'fakesesskey02';
          return { validationerror: true };
        },
      },
    });
    const web = api.web as { sesskey: () => Promise<string> };
    web.sesskey = async () => key;
    const preview = await prepareCalendarEvent(ctx, { action: 'create', name: 'x', start: '2030-12-02T10:30' });
    const result = await confirmAction(ctx, preview.actionId, 'mcp');
    expect(result).toMatchObject({ status: 'executed', message: "Created calendar event 'x' (event_id 5203)." });
    expect(sent.map((a) => formOf(a).get('sesskey'))).toEqual(['fakesesskey01', 'fakesesskey02']);
  });

  it('warns about a start in the past', async () => {
    const { ctx } = webSetup({});
    const preview = await prepareCalendarEvent(ctx, { action: 'create', name: 'x', start: '2020-01-06T09:00' });
    expect(preview.warnings).toContain('The start time is in the past.');
  });

  it('refuses incomplete or inconsistent input before saving anything', async () => {
    const { ctx } = webSetup({});
    const create = (over: Args) =>
      prepareCalendarEvent(ctx, { action: 'create', name: 'x', start: '2030-12-02T10:30', ...over });
    await expect(create({ start: undefined })).rejects.toThrow('start is required');
    await expect(create({ name: '  ' })).rejects.toThrow('event name is empty');
    await expect(create({ end: '2030-12-02T10:00' })).rejects.toThrow('end must be after start');
    await expect(create({ end: '2030-12-02T11:00', durationMinutes: 30 })).rejects.toThrow('not both');
    await expect(create({ start: 'tomorrow 10am' })).rejects.toThrow('ISO date and time');
  });
});

describe('prepare_calendar_event edit / delete (web channel)', () => {
  it('edits only the given fields and keeps the length, through the update form', async () => {
    const submit = recorder({ event: { id: 5101, timestart: START + DAY }, validationerror: false });
    const { ctx } = webSetup({
      ajax: {
        core_calendar_get_calendar_event_by_id: { event: personal(), warnings: [] },
        core_calendar_submit_create_update_form: submit.fn,
      },
    });
    const preview = await prepareCalendarEvent(ctx, { action: 'edit', eventId: 5101, start: '2030-12-03T10:30' });
    expect(preview.title).toBe("Edit calendar event '面談 & 準備'");
    expect(preview.details).toEqual([
      'Now: 面談 & 準備 · 2030-12-02 Mon 10:30 – 2030-12-02 Mon 11:30 JST',
      'After the change:',
      'Name: 面談 & 準備',
      'When: 2030-12-03 Tue 10:30 – 2030-12-03 Tue 11:30 JST',
      'Description: 研究室',
    ]);
    const result = await confirmAction(ctx, preview.actionId, 'mcp');
    expect(result.message).toBe("Updated calendar event '面談 & 準備' (event_id 5101).");
    const form = formOf(submit.sent[0]);
    expect(form.get('id')).toBe('5101');
    expect(form.get('_qf__core_calendar_local_event_forms_update')).toBe('1');
    expect(form.has('_qf__core_calendar_local_event_forms_create')).toBe(false);
    expect(form.get('timestart[day]')).toBe('3');
    expect(form.get('timedurationuntil[hour]')).toBe('11');
    expect(form.get('timedurationuntil[minute]')).toBe('30');
    expect(form.get('description[text]')).toBe('<p>研究室</p>');
    // this occurrence only: the update form's default (1) would rewrite the whole series
    expect(form.get('repeateditall')).toBe('0');
    expect(form.has('repeat')).toBe(false);
  });

  it('warns that an edit of a repeated event changes this occurrence only', async () => {
    const repeated = { event: personal({ repeatid: 77 }) };
    const { ctx } = webSetup({ ajax: { core_calendar_get_calendar_event_by_id: repeated } });
    const preview = await prepareCalendarEvent(ctx, { action: 'edit', eventId: 5101, name: '面談' });
    expect(preview.warnings).toEqual(['This event is one of a repeated series; only this occurrence is changed.']);
  });

  it('clears the description with "" and warns when nothing changes', async () => {
    const { ctx } = webSetup({ ajax: { core_calendar_get_calendar_event_by_id: { event: personal() } } });
    const cleared = await prepareCalendarEvent(ctx, { action: 'edit', eventId: 5101, description: '' });
    expect(cleared.details).not.toContain('Description: 研究室');
    const same = await prepareCalendarEvent(ctx, { action: 'edit', eventId: 5101, name: '面談 & 準備' });
    expect(same.warnings).toContain('Nothing changes: the event already has these values.');
    await expect(prepareCalendarEvent(ctx, { action: 'edit', eventId: 5101 })).rejects.toThrow('at least one');
  });

  it.each([
    ['a course event', { eventtype: 'course', courseid: 99101, userid: 2 }, 'course event'],
    ['an activity event', { eventtype: 'due', modulename: 'assign', courseid: 99101 }, 'due event'],
    ["another user's event", { userid: 9999 }, 'user event'],
  ])('refuses %s', async (_label, over, type) => {
    const submit = recorder({});
    const { ctx } = webSetup({
      ajax: {
        core_calendar_get_calendar_event_by_id: { event: personal(over) },
        core_calendar_submit_create_update_form: submit.fn,
        core_calendar_delete_calendar_events: submit.fn,
      },
    });
    for (const action of ['edit', 'delete'] as const) {
      const attempt = prepareCalendarEvent(ctx, { action, eventId: 5101, name: 'y' });
      await expect(attempt).rejects.toThrow(`is a ${type}, not one of your personal events`);
    }
    expect(submit.sent).toEqual([]);
  });

  it("follows Moodle's own edit / delete verdicts and answers a missing event as not found", async () => {
    const locked = webSetup({
      ajax: { core_calendar_get_calendar_event_by_id: { event: personal({ canedit: false, candelete: false }) } },
    });
    await expect(prepareCalendarEvent(locked.ctx, { action: 'edit', eventId: 5101, name: 'y' })).rejects.toThrow(
      'does not let you edit',
    );
    const missing = webSetup({
      ajax: {
        core_calendar_get_calendar_event_by_id: () => {
          throw new MoodleError('Can not find data record in database.', 'invalidrecord');
        },
      },
    });
    const attempt = prepareCalendarEvent(missing.ctx, { action: 'delete', eventId: 5101 });
    await expect(attempt).rejects.toBeInstanceOf(NotFound);
  });

  it('deletes one occurrence after the preview', async () => {
    const del = recorder(null);
    const { ctx } = webSetup({
      ajax: {
        core_calendar_get_calendar_event_by_id: { event: personal({ repeatid: 77 }) },
        core_calendar_delete_calendar_events: del.fn,
      },
    });
    const preview = await prepareCalendarEvent(ctx, { action: 'delete', eventId: 5101 });
    expect(preview).toMatchObject({ kind: 'calendar_event_delete', title: "Delete calendar event '面談 & 準備'" });
    expect(preview.warnings).toEqual([
      'Deleting cannot be undone.',
      'This event is one of a repeated series; only this occurrence is deleted.',
    ]);
    expect(del.sent).toEqual([]);
    const result = await confirmAction(ctx, preview.actionId, 'mcp');
    expect(result).toMatchObject({ status: 'executed', message: "Deleted calendar event '面談 & 準備'." });
    expect(del.sent).toEqual([{ events: [{ eventid: 5101, repeat: 0 }] }]);
  });
});

describe('prepare_calendar_event on the ws channel', () => {
  it('creates through core_calendar_create_calendar_events', async () => {
    const { ctx, moodle } = createTestContext({
      handlers: { core_calendar_create_calendar_events: { events: [{ id: 5301, timestart: START }], warnings: [] } },
    });
    const preview = await prepareCalendarEvent(ctx, { action: 'create', name: '自習', start: '2030-12-02T10:30' });
    const result = await confirmAction(ctx, preview.actionId, 'mcp');
    expect(result.message).toBe("Created calendar event '自習' (event_id 5301).");
    expect(moodle.callsTo('core_calendar_create_calendar_events')).toEqual([
      {
        events: [
          {
            name: '自習',
            description: '',
            format: 1,
            courseid: 0,
            groupid: 0,
            repeats: 0,
            eventtype: 'user',
            timestart: START,
            timeduration: 0,
            visible: 1,
          },
        ],
      },
    ]);
  });

  it('refuses an edit at prepare, before reading the event, and the executor refuses it too', async () => {
    const { ctx, moodle } = createTestContext({
      handlers: { core_calendar_get_calendar_event_by_id: { event: personal() } },
    });
    const attempt = prepareCalendarEvent(ctx, { action: 'edit', eventId: 5101, name: 'y' });
    await expect(attempt).rejects.toMatchObject({
      errorcode: 'servicenotavailable',
      message: 'Only available through the Moodle web session.',
      url: 'https://wsdmoodle.waseda.jp/calendar/view.php?view=upcoming',
    });
    expect(moodle.callsTo('core_calendar_get_calendar_event_by_id')).toEqual([]);
    const payload = { eventId: 5101, name: 'y', timestart: START, timeend: START, descriptionHtml: '', location: '' };
    const run = executeCalendarEventEdit(moodle, { ...payload, url: '' });
    await expect(run).rejects.toMatchObject({ errorcode: 'servicenotavailable' });
    expect(moodle.callsTo('core_calendar_submit_create_update_form')).toEqual([]);
  });

  it('fails with Moodle’s warning when nothing was created', async () => {
    const { ctx } = createTestContext({
      handlers: {
        core_calendar_create_calendar_events: { events: [], warnings: [{ message: 'No permission.' }] },
      },
    });
    const preview = await prepareCalendarEvent(ctx, { action: 'create', name: '自習', start: '2030-12-02T10:30' });
    const result = await confirmAction(ctx, preview.actionId, 'mcp');
    expect(result.status).toBe('failed');
    expect(result.message).toContain('Moodle did not create the event: No permission.');
  });
});

describe('parseEventTime', () => {
  it('reads JST without an offset, honours an offset, drops seconds and refuses impossible dates', () => {
    expect(parseEventTime('2030-12-02T10:30', 'start')).toBe(START);
    expect(parseEventTime('2030-12-02 10:30:59', 'start')).toBe(START);
    expect(parseEventTime('2030-12-02T01:30Z', 'start')).toBe(START);
    expect(parseEventTime('2030-12-02T10:30+09:00', 'start')).toBe(START);
    expect(() => parseEventTime('2030-02-30T10:00', 'start')).toThrow('ISO date and time');
    expect(() => parseEventTime('2030-12-02T24:00', 'end')).toThrow('end must be');
  });
});

describe('list_calendar_events', () => {
  const events = [
    { id: 3, name: 'Quiz 2 closes', eventtype: 'close', modulename: 'quiz', courseid: 99101, timestart: START + 7200 },
    {
      id: 2,
      name: '自習',
      eventtype: 'user',
      courseid: 0,
      timestart: START + HOUR,
      timeduration: 1800,
      description: '<b>図書館</b>',
    },
    { id: 1, name: '面談', eventtype: 'user', courseid: 0, timestart: START, timeduration: 0 },
  ];

  function listSetup() {
    const res = recorder({ events, warnings: [] });
    const { api, ctx } = webSetup({ handlers: { core_calendar_get_calendar_events: res.fn } });
    return { api, ctx, sent: res.sent };
  }

  it('lists personal events by default in one call, sorted by start', async () => {
    const { api, ctx, sent } = listSetup();
    const r = await listCalendarEvents(ctx, { daysAhead: 7 });
    expect(r.events.map((e) => e.id)).toEqual([1, 2]);
    expect(r.events[1]).toMatchObject({ personal: true, description: '図書館', courseId: null });
    expect(r.events[1]?.end).toBe('2030-12-02T12:00:00+09:00');
    const options = sent[0]?.options as Args;
    expect(options).toMatchObject({ userevents: 1, siteevents: 0 });
    expect(Number(options.timeend) - Number(options.timestart)).toBe(7 * DAY);
    expect(api.calls).toHaveLength(1);
    expect(renderCalendarEvents(r)).toContain('面談 (personal, event_id 1)');
  });

  it('adds course and activity events on request and caps the window at 90 days', async () => {
    const { ctx, sent } = listSetup();
    const r = await listCalendarEvents(ctx, { daysAhead: 500, includeCourseEvents: true });
    expect(r.events.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(r.events[2]).toMatchObject({ personal: false, eventType: 'close', module: 'quiz', courseId: 99101 });
    const options = sent[0]?.options as Args;
    expect(Number(options.timeend) - Number(options.timestart)).toBe(90 * DAY);
    expect(renderCalendarEvents(r)).toContain('Quiz 2 closes (close quiz, event_id 3) · course_id 99101');
  });

  it('asks the web service for the enrolled courses with course events (its [] means no course)', async () => {
    const { ctx, moodle } = createTestContext({
      handlers: {
        core_course_get_enrolled_courses_by_timeline_classification: { courses: [{ id: 99101 }, { id: 99102 }] },
        core_calendar_get_calendar_events: { events, warnings: [] },
      },
    });
    const r = await listCalendarEvents(ctx, { includeCourseEvents: true });
    expect(r.events.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(moodle.callsTo('core_calendar_get_calendar_events')[0]?.events).toEqual({ courseids: [99101, 99102] });
    await listCalendarEvents(ctx);
    expect(moodle.callsTo('core_calendar_get_calendar_events')[1]?.events).toEqual({ courseids: [] });
    expect(moodle.callsTo('core_course_get_enrolled_courses_by_timeline_classification')).toHaveLength(1);
  });

  it('asks the web emulation for every course ([]) without listing the courses', async () => {
    const { api, ctx, sent } = listSetup();
    await listCalendarEvents(ctx, { includeCourseEvents: true });
    expect(sent[0]?.events).toEqual({ courseids: [] });
    expect(api.calls.map((c) => c.fn)).toEqual(['core_calendar_get_calendar_events']);
  });

  it('says how to see more when there is no personal event', async () => {
    const res = recorder({ events: [events[0]], warnings: [] });
    const { ctx } = webSetup({ handlers: { core_calendar_get_calendar_events: res.fn } });
    const text = renderCalendarEvents(await listCalendarEvents(ctx));
    expect(text).toContain('No personal events in this period. Pass include_course_events');
  });
});
