import { Link } from 'react-router';
import type { CourseOverviewItem } from '../../api/types';
import { useI18n } from '../../i18n';
import { classFirst } from '../../lib/courses';
import { Card } from '../Card';
import { EmptyState } from '../EmptyState';
import { ScheduleSummary } from './CourseSchedule';

function Counts({ counts }: { counts: CourseOverviewItem['counts'] }) {
  const { t } = useI18n();
  return (
    <div className="cv-counts">
      {counts.overdue > 0 && (
        <span className="badge badge-danger">{t('courses.view.count.overdue', { count: counts.overdue })}</span>
      )}
      <span className="badge">{t('courses.view.count.todo', { count: counts.todo })}</span>
      {counts.draft > 0 && (
        <span className="badge badge-warn">{t('courses.view.count.draft', { count: counts.draft })}</span>
      )}
    </div>
  );
}

function CourseRow({ course, showCounts }: { course: CourseOverviewItem; showCounts: boolean }) {
  return (
    <li className="row cv-row">
      <div className="row-main">
        <Link to={`/courses/${course.id}`} className="due-name">
          {course.name}
        </Link>
        <div className="row-meta">
          <ScheduleSummary schedule={course.schedule} />
        </div>
      </div>
      {showCounts && <Counts counts={course.counts} />}
    </li>
  );
}

/**
 * Courses in the selection, class courses first (API order otherwise); empty selection links to Settings → This
 * term's courses. Counts are hidden when the due fetch failed (they would all be zero).
 */
export function CourseList({ courses, dueError }: { courses: CourseOverviewItem[]; dueError: boolean }) {
  const { t } = useI18n();
  if (courses.length === 0) {
    return (
      <Card>
        <EmptyState action={<Link to="/settings/courses">{t('courses.view.select')}</Link>}>
          {t('courses.view.empty')}
        </EmptyState>
      </Card>
    );
  }
  return (
    <Card>
      <ul className="rows">
        {classFirst(courses).map((c) => (
          <CourseRow key={c.id} course={c} showCounts={!dueError} />
        ))}
      </ul>
    </Card>
  );
}
