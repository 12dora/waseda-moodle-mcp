import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { getDue, patchSettings } from '../api/endpoints';
import type { DueItem } from '../api/types';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { DueRow } from '../components/DueRow';
import { EmptyState } from '../components/EmptyState';
import { ErrorBox } from '../components/ErrorBox';
import { PageHeader } from '../components/Layout';
import { PageLoading } from '../components/Spinner';
import { useToast } from '../components/Toast';
import { useT } from '../i18n';
import { errorText } from '../lib/errors';
import { DUE_GROUPS, type DueGroup, dueGroup } from '../lib/time';
import { useAsync } from '../lib/useAsync';
import { useSession } from '../session';

export function DuePage() {
  const t = useT();
  const toast = useToast();
  const { me, setSettings } = useSession();
  const due = useAsync(() => getDue(14));
  const [courseId, setCourseId] = useState<number | 'all'>('all');
  const [hiding, setHiding] = useState(false);
  const filterId = useId();

  const courses = useMemo(() => {
    const map = new Map<number, string>();
    for (const it of due.data?.items ?? []) map.set(it.courseId, it.courseName);
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [due.data]);

  const groups = useMemo(() => {
    const now = Date.now();
    const out = new Map<DueGroup, DueItem[]>();
    for (const it of due.data?.items ?? []) {
      if (courseId !== 'all' && it.courseId !== courseId) continue;
      const g = it.overdue ? 'overdue' : dueGroup(it.dueAt ?? it.opensAt, { now, deadline: it.dueAt !== null });
      const list = out.get(g) ?? [];
      list.push(it);
      out.set(g, list);
    }
    return DUE_GROUPS.flatMap((g) => {
      const items = out.get(g);
      return items ? [{ group: g, items }] : [];
    });
  }, [due.data, courseId]);

  const hideCourse = async (id: number) => {
    setHiding(true);
    try {
      const ids = [...new Set([...me.user.settings.hiddenCourseIds, id])];
      const { settings } = await patchSettings({ hiddenCourseIds: ids });
      setSettings(settings);
      setCourseId('all');
      toast.show(t('due.courseHidden'));
      due.reload();
    } catch (e) {
      toast.show(errorText(e, t), 'error');
    } finally {
      setHiding(false);
    }
  };

  return (
    <>
      <PageHeader title={t('due.title')} desc={t('due.window')} />
      {due.loading && !due.data && <PageLoading label={t('common.loading')} />}
      {due.error != null && <ErrorBox error={due.error} onRetry={due.reload} />}
      {due.data && (
        <>
          <div className="toolbar">
            <div className="field field-inline">
              <label htmlFor={filterId} className="field-label">
                {t('due.course')}
              </label>
              <select
                id={filterId}
                className="input select"
                value={String(courseId)}
                onChange={(e) => setCourseId(e.target.value === 'all' ? 'all' : Number(e.target.value))}
              >
                <option value="all">{t('due.allCourses')}</option>
                {courses.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            {courseId !== 'all' && (
              <Button size="sm" variant="ghost" busy={hiding} onClick={() => hideCourse(courseId)}>
                {t('due.hideCourse')}
              </Button>
            )}
          </div>

          {(due.data.hiddenCourseCount > 0 || due.data.truncated) && (
            <div className="notes">
              {due.data.hiddenCourseCount > 0 && (
                <p className="muted">
                  {t('due.hiddenCount', { count: due.data.hiddenCourseCount })}{' '}
                  <Link to="/settings#hidden">{t('due.manage')}</Link>
                </p>
              )}
              {due.data.truncated && <p className="muted">{t('due.truncated')}</p>}
            </div>
          )}

          {groups.length === 0 ? (
            <Card>
              <EmptyState>{t('due.empty')}</EmptyState>
            </Card>
          ) : (
            groups.map(({ group, items }) => (
              <Card
                key={group}
                title={t(`due.group.${group}`)}
                className={group === 'overdue' ? 'card-danger' : undefined}
              >
                <ul className="due-list">
                  {items.map((item) => (
                    <DueRow
                      key={`${item.kind}-${item.cmid ?? item.url}-${item.dueAt}`}
                      item={item}
                      showCourse={courseId === 'all'}
                    />
                  ))}
                </ul>
              </Card>
            ))
          )}
        </>
      )}
    </>
  );
}
