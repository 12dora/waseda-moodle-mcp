import { getSyllabusSummary } from '../../api/endpoints';
import type { CourseOverviewItem, GradingRow, SyllabusSummary } from '../../api/types';
import { useI18n } from '../../i18n';
import { type AsyncState, useAsync } from '../../lib/useAsync';
import { Card } from '../Card';
import { Spinner } from '../Spinner';

type Grading = Pick<SyllabusSummary, 'grading' | 'gradingText'>;

function GradingTable({ rows }: { rows: GradingRow[] }) {
  const { t } = useI18n();
  return (
    <div className="table-wrap">
      <table className="table cv-grading">
        <thead>
          <tr>
            <th scope="col" className="cv-method">
              {t('courses.view.method')}
            </th>
            <th scope="col" className="cv-weight">
              {t('courses.view.weight')}
            </th>
            <th scope="col">{t('courses.view.criteria')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.method}|${r.weight}|${r.criteria}`}>
              <td className="cv-method">{r.method}</td>
              <td className="cv-weight">{r.weight === null ? '–' : `${r.weight}%`}</td>
              <td className="cv-criteria">{r.criteria}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GradingBody({ grading }: { grading: Grading }) {
  const { t } = useI18n();
  if (grading.grading?.length) return <GradingTable rows={grading.grading} />;
  if (grading.gradingText) return <p className="cv-grading-text">{grading.gradingText}</p>;
  return <p className="muted">{t('courses.view.gradingNotFound')}</p>;
}

/** Syllabus for the detail page: the overview's cache, or one /api/syllabus fetch when the cache has no result. */
interface CourseSyllabus {
  url: string | null;
  /** 'loading' / 'error' only while / after the lazy fetch. */
  grading: Grading | 'loading' | 'error';
}

const fetchSyllabus = (courseId: number | null) =>
  courseId === null ? Promise.resolve(null) : getSyllabusSummary(courseId);

function lazyGrading(state: AsyncState<SyllabusSummary | null>): CourseSyllabus['grading'] {
  if (state.error != null || state.data?.status === 'error') return 'error';
  return state.data ?? 'loading';
}

export function useCourseSyllabus(course: CourseOverviewItem): CourseSyllabus {
  const lazy = course.syllabusStatus === 'unknown';
  const state = useAsync(fetchSyllabus, lazy ? course.id : null);
  if (!lazy) return { url: course.syllabusUrl, grading: course };
  return { url: state.data?.url ?? course.syllabusUrl, grading: lazyGrading(state) };
}

/** Syllabus grading: method, weight and criteria. A failed lazy fetch is a muted note, not an error box. */
export function GradingCard({ grading }: { grading: CourseSyllabus['grading'] }) {
  const { t } = useI18n();
  return (
    <Card title={t('courses.view.grading')}>
      {grading === 'loading' && <Spinner label={t('common.loading')} />}
      {grading === 'error' && <p className="muted">{t('courses.view.gradingError')}</p>}
      {typeof grading === 'object' && <GradingBody grading={grading} />}
    </Card>
  );
}
