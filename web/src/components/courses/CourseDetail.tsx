import { Link } from 'react-router';
import type { CourseOverviewItem } from '../../api/types';
import { useI18n } from '../../i18n';
import { Card } from '../Card';
import { EmptyState } from '../EmptyState';
import { PageHeader } from '../Layout';
import { AssignmentsCard } from './CourseAssignments';
import { GradingCard, useCourseSyllabus } from './CourseGrading';
import { ScheduleCard } from './CourseSchedule';
import { UpdatesCard } from './CourseUpdates';

export function BackLink() {
  const { t } = useI18n();
  return (
    <Link to="/courses" className="cv-back">
      <span aria-hidden="true">‹ </span>
      {t('nav.courses')}
    </Link>
  );
}

/** Shown on the list and the detail page when the live due fetch failed (items and counts are empty). */
export function DueErrorNote() {
  const { t } = useI18n();
  return (
    <p className="muted cv-notice" role="status">
      {t('courses.view.dueError')}
    </p>
  );
}

function ExternalLinks({ course, syllabusUrl }: { course: CourseOverviewItem; syllabusUrl: string | null }) {
  const { t } = useI18n();
  return (
    <div className="cv-links">
      <a href={course.url} target="_blank" rel="noopener noreferrer" className="btn btn-secondary btn-sm">
        {t('courses.view.openMoodle')}
      </a>
      {syllabusUrl && (
        <a href={syllabusUrl} target="_blank" rel="noopener noreferrer" className="btn btn-secondary btn-sm">
          {t('courses.view.syllabus')}
        </a>
      )}
    </div>
  );
}

/**
 * One course: assignments by status, class times, grading and recent updates. The back link is rendered by the
 * page; assignments are left out when the due fetch failed (the notice explains why).
 */
export function CourseDetail({ course, dueError }: { course: CourseOverviewItem; dueError: boolean }) {
  const syllabus = useCourseSyllabus(course);
  return (
    <>
      <PageHeader title={course.name} actions={<ExternalLinks course={course} syllabusUrl={syllabus.url} />} />
      {dueError ? <DueErrorNote /> : <AssignmentsCard items={course.items} />}
      <ScheduleCard schedule={course.schedule} />
      <GradingCard grading={syllabus.grading} />
      <UpdatesCard updates={course.updates} />
    </>
  );
}

/** Detail URL for a course that is not in the selection (or no longer is). */
export function CourseNotFound() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader title={t('nav.courses')} />
      <Card>
        <EmptyState>{t('courses.view.notFound')}</EmptyState>
      </Card>
    </>
  );
}
