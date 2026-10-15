import type { TimetableClass } from '../api/types';
import { useI18n } from '../i18n';
import { formatDay } from '../lib/time';

/** Course reference handed to the schedule editor. */
export interface EditTarget {
  courseId: number;
  courseName: string;
}

export type OnEdit = (target: EditTarget) => void;

/** Small icon button that opens the schedule editor for one course. */
function EditTimeButton({ target, onEdit }: { target: EditTarget; onEdit: OnEdit }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="tt-edit"
      title={t('timetable.edit')}
      aria-label={t('timetable.editFor', { course: target.courseName })}
      onClick={() => onEdit(target)}
    >
      <span aria-hidden="true">✎</span>
    </button>
  );
}

/** "Set by you" marker for user-set times. */
export function UserMark() {
  const { t } = useI18n();
  return <span className="tt-mark">{t('timetable.setByYou')}</span>;
}

/** One class: link to the Moodle course, plus an edit action when `onEdit` is given. */
export function ClassLink({ c, date, onEdit }: { c: TimetableClass; date: string; onEdit?: OnEdit }) {
  const { t, lang } = useI18n();
  const time = `${c.start}–${c.end}`;
  return (
    <div className="tt-item">
      <a
        href={c.url}
        target="_blank"
        rel="noopener noreferrer"
        className="tt-class"
        aria-label={t('timetable.classLabel', { day: formatDay(date, lang), time, course: c.courseName })}
        title={c.source === 'moodle' ? t('timetable.fromMoodle') : undefined}
      >
        <span className="tt-time">{time}</span>
        <span className="tt-name">{c.courseName}</span>
        {(c.classroom || c.campus) && (
          <span className="tt-room">{[c.classroom, c.campus].filter(Boolean).join(' · ')}</span>
        )}
        {c.source === 'user' && <UserMark />}
      </a>
      {onEdit && <EditTimeButton target={c} onEdit={onEdit} />}
    </div>
  );
}
