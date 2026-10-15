import { Link } from 'react-router';
import type { CourseSchedule, CourseSlot } from '../../api/types';
import { type I18n, useI18n } from '../../i18n';
import { scheduleKind } from '../../lib/courses';
import { weekdayName } from '../../lib/time';
import { Card } from '../Card';

/** '周二 3–4 限' / '火 3–4限' / 'Tue P3–4'. */
function slotText(slot: CourseSlot, { t, lang }: Pick<I18n, 't' | 'lang'>): string {
  const periods =
    slot.periodFrom === slot.periodTo
      ? t('courses.view.period', { n: slot.periodFrom })
      : t('courses.view.periods', { from: slot.periodFrom, to: slot.periodTo });
  return `${weekdayName(slot.weekday, lang)} ${periods}`;
}

const slotKey = (s: CourseSlot) => `${s.weekday}-${s.periodFrom}-${s.periodTo}-${s.classroom ?? ''}`;

/** One-line schedule for the course list; nothing when the class time is unknown. */
export function ScheduleSummary({ schedule }: { schedule: CourseSchedule }) {
  const i18n = useI18n();
  const { t } = i18n;
  const kind = scheduleKind(schedule);
  if (kind === 'unknown') return null;
  if (kind === 'no-fixed-time') return <span>{t('courses.view.noFixedTime')}</span>;
  const onDemand = schedule.listing === 'on-demand' && <span className="tag">{t('courses.view.onDemand')}</span>;
  if (kind === 'on-demand') return onDemand;
  return (
    <>
      <span>{schedule.slots.map((s) => slotText(s, i18n)).join(', ')}</span>
      {onDemand}
    </>
  );
}

function SlotRow({ slot }: { slot: CourseSlot }) {
  const i18n = useI18n();
  const place = [slot.classroom, slot.campus].filter(Boolean).join(' · ');
  const time = slot.start && slot.end ? `${slot.start}–${slot.end}` : null;
  return (
    <li className="row">
      <div className="row-main">
        <span className="row-title">{slotText(slot, i18n)}</span>
        {(time || place) && (
          <div className="row-meta">
            {time && <span className="cv-time">{time}</span>}
            {place && <span>{place}</span>}
          </div>
        )}
      </div>
    </li>
  );
}

function ScheduleNote({ schedule }: { schedule: CourseSchedule }) {
  const { t } = useI18n();
  const kind = scheduleKind(schedule);
  if (kind === 'unknown') {
    return (
      <p className="muted cv-note">
        {t('courses.view.timeUnknown')} <Link to="/timetable">{t('courses.view.setTime')}</Link>
      </p>
    );
  }
  if (kind === 'no-fixed-time') return <p className="muted cv-note">{t('courses.view.noFixedTime')}</p>;
  if (schedule.listing !== 'on-demand') return null;
  const note = kind === 'weekly' ? 'courses.view.hybrid' : 'courses.view.onDemandNote';
  return <p className="muted cv-note">{t(note)}</p>;
}

/** Weekly slots with real times, room and campus; on-demand / no fixed time / unknown as a note. */
export function ScheduleCard({ schedule }: { schedule: CourseSchedule }) {
  const { t } = useI18n();
  return (
    <Card title={t('courses.view.schedule')}>
      {schedule.slots.length > 0 && (
        <ul className="rows">
          {schedule.slots.map((s) => (
            <SlotRow key={slotKey(s)} slot={s} />
          ))}
        </ul>
      )}
      <ScheduleNote schedule={schedule} />
    </Card>
  );
}
