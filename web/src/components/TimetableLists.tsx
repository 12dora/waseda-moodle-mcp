import type { ReactNode } from 'react';
import type { TimetableCourseRef, TimetableUnknown, TimetableUnscheduled } from '../api/types';
import { useI18n } from '../i18n';
import { useSession } from '../session';
import { Button } from './Button';
import { Card } from './Card';
import { type OnEdit, UserMark } from './ClassLink';

interface Row {
  course: TimetableCourseRef;
  meta?: ReactNode;
}

function CourseRows({ title, rows, action, onEdit }: { title: string; rows: Row[]; action: string; onEdit: OnEdit }) {
  const { me } = useSession();
  const overrides = me.user.settings.scheduleOverrides;
  if (rows.length === 0) return null;
  return (
    <Card title={title}>
      <ul className="rows">
        {rows.map(({ course, meta }) => (
          <li key={course.courseId} className="row tt-ref">
            <div className="row-main">
              <a href={course.url} target="_blank" rel="noopener noreferrer">
                {course.courseName}
              </a>
              {(meta || overrides[String(course.courseId)]) && (
                <div className="row-meta">
                  {meta}
                  {overrides[String(course.courseId)] && <UserMark />}
                </div>
              )}
            </div>
            <Button size="sm" variant="ghost" onClick={() => onEdit(course)}>
              {action}
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Courses without weekly slots, split into on-demand and "no weekly class"; hybrids are marked. */
export function UnscheduledLists({ items, onEdit }: { items: TimetableUnscheduled[]; onEdit: OnEdit }) {
  const { t } = useI18n();
  const rows = (kind: TimetableUnscheduled['kind']) =>
    items
      .filter((c) => c.kind === kind)
      .map((c) => ({ course: c, meta: c.alsoInClass ? <span>{t('timetable.alsoInClass')}</span> : undefined }));
  return (
    <>
      <CourseRows
        title={t('timetable.onDemand')}
        rows={rows('on-demand')}
        action={t('timetable.edit')}
        onEdit={onEdit}
      />
      <CourseRows
        title={t('timetable.noFixedTime')}
        rows={rows('no-fixed-time')}
        action={t('timetable.edit')}
        onEdit={onEdit}
      />
    </>
  );
}

/** Courses whose class time is not known; each can be set by hand. */
export function UnknownList({ items, onEdit }: { items: TimetableUnknown[]; onEdit: OnEdit }) {
  const { t } = useI18n();
  const rows = items.map((c) => ({
    course: c,
    meta: c.reason === 'pending' ? <span>{t('timetable.pending')}</span> : undefined,
  }));
  return <CourseRows title={t('timetable.unknown')} rows={rows} action={t('timetable.setTime')} onEdit={onEdit} />;
}
