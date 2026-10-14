import { useState } from 'react';
import { getCourses, patchSettings } from '../api/endpoints';
import type { Course, CoursesResponse } from '../api/types';
import { AsyncBlock } from '../components/AsyncBlock';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/Layout';
import { useToast } from '../components/Toast';
import { useI18n } from '../i18n';
import { errorText } from '../lib/errors';
import { formatDate } from '../lib/time';
import { useAsync } from '../lib/useAsync';
import { useSession } from '../session';

function CourseItem({ course, checked, onToggle }: { course: Course; checked: boolean; onToggle: () => void }) {
  const { t, lang } = useI18n();
  return (
    <li className="course-item">
      <label>
        <input type="checkbox" checked={checked} onChange={onToggle} />
        <span className="course-text">
          <span>{course.name}</span>
          <span className="row-meta">
            {course.suggested && <span className="badge badge-ok">{t('courses.suggested')}</span>}
            {course.term && <span>{course.term}</span>}
            <span>
              {course.lastAccess
                ? t('courses.lastAccess', { time: formatDate(course.lastAccess, lang) })
                : t('courses.notAccessed')}
            </span>
          </span>
        </span>
      </label>
    </li>
  );
}

function CourseList({
  courses,
  selected,
  onToggle,
}: {
  courses: Course[];
  selected: Set<number>;
  onToggle: (id: number) => void;
}) {
  return (
    <ul className="course-list">
      {courses.map((c) => (
        <CourseItem key={c.id} course={c} checked={selected.has(c.id)} onToggle={() => onToggle(c.id)} />
      ))}
    </ul>
  );
}

function CourseEditor({ data, onSaved }: { data: CoursesResponse; onSaved: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const { setSettings } = useSession();
  const [selected, setSelected] = useState(() => new Set(data.courses.filter((c) => c.mine).map((c) => c.id)));
  const [busy, setBusy] = useState<'save' | 'auto' | null>(null);
  const classes = data.courses.filter((c) => c.kind === 'class');
  const others = data.courses.filter((c) => c.kind === 'other');

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const save = async (ids: number[] | null) => {
    setBusy(ids === null ? 'auto' : 'save');
    try {
      const res = await patchSettings({ myCourseIds: ids });
      setSettings(res.settings);
      toast.show(t('common.saved'));
      onSaved();
    } catch (e) {
      toast.show(errorText(e, t), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <p className={data.mode === 'auto' ? 'alert alert-info' : 'muted'}>
        {data.mode === 'auto' ? t('courses.modeAuto') : t('courses.modeMine', { count: selected.size })}
      </p>
      <Card title={t('courses.class')}>
        {classes.length === 0 ? (
          <EmptyState>{t('courses.empty')}</EmptyState>
        ) : (
          <CourseList courses={classes} selected={selected} onToggle={toggle} />
        )}
      </Card>
      {others.length > 0 && (
        <Card>
          <details className="disclosure">
            <summary>{t('courses.other', { count: others.length })}</summary>
            <CourseList courses={others} selected={selected} onToggle={toggle} />
          </details>
        </Card>
      )}
      <div className="sticky-actions">
        <Button variant="primary" busy={busy === 'save'} disabled={busy !== null} onClick={() => save([...selected])}>
          {t('courses.save')}
        </Button>
        {data.mode === 'mine' && (
          <Button variant="ghost" busy={busy === 'auto'} disabled={busy !== null} onClick={() => save(null)}>
            {t('courses.useAuto')}
          </Button>
        )}
        <span className="muted small">{t('courses.selected', { count: selected.size })}</span>
      </div>
    </>
  );
}

export function MyCoursesPage() {
  const { t } = useI18n();
  const courses = useAsync(getCourses);
  return (
    <>
      <PageHeader title={t('courses.title')} desc={t('courses.desc')} />
      <AsyncBlock state={courses}>
        {(data) => <CourseEditor key={data.mode} data={data} onSaved={courses.reload} />}
      </AsyncBlock>
    </>
  );
}
