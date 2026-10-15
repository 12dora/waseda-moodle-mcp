import { Link, useParams } from 'react-router';
import { getCourseOverview } from '../api/endpoints';
import type { CourseOverview } from '../api/types';
import { AsyncBlock } from '../components/AsyncBlock';
import { BackLink, CourseDetail, CourseNotFound, DueErrorNote } from '../components/courses/CourseDetail';
import { CourseList } from '../components/courses/CourseList';
import { PageHeader } from '../components/Layout';
import { ScopeBanner } from '../components/ScopeBanner';
import { useI18n } from '../i18n';
import { type AsyncState, useAsync } from '../lib/useAsync';

function DetailView({ overview, courseId }: { overview: CourseOverview; courseId: string }) {
  const course = overview.courses.find((c) => String(c.id) === courseId);
  return course ? <CourseDetail course={course} dueError={overview.dueError} /> : <CourseNotFound />;
}

/** Back link always; a generic title until the course is loaded, so loading and error states have both. */
function DetailPage({ overview, courseId }: { overview: AsyncState<CourseOverview>; courseId: string }) {
  const { t } = useI18n();
  return (
    <>
      <BackLink />
      {overview.data === undefined && <PageHeader title={t('nav.courses')} />}
      <AsyncBlock state={overview}>{(data) => <DetailView overview={data} courseId={courseId} />}</AsyncBlock>
    </>
  );
}

/** My courses: `/courses` lists the selection, `/courses/:courseId` shows one course; both read one overview fetch. */
export function CoursesPage() {
  const { t } = useI18n();
  const { courseId } = useParams();
  const overview = useAsync(getCourseOverview);
  if (courseId) return <DetailPage overview={overview} courseId={courseId} />;
  return (
    <>
      <PageHeader
        title={t('nav.courses')}
        desc={t('courses.view.desc')}
        actions={<Link to="/settings/courses">{t('courses.view.manage')}</Link>}
      />
      <ScopeBanner />
      <AsyncBlock state={overview}>
        {(data) => (
          <>
            {data.dueError && <DueErrorNote />}
            <CourseList courses={data.courses} dueError={data.dueError} />
          </>
        )}
      </AsyncBlock>
    </>
  );
}
