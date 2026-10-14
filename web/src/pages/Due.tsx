import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { getDue } from '../api/endpoints';
import type { DueItem, DueList } from '../api/types';
import { Card } from '../components/Card';
import { DueRow } from '../components/DueRow';
import { EmptyState } from '../components/EmptyState';
import { ErrorBox } from '../components/ErrorBox';
import { PageHeader } from '../components/Layout';
import { ScopeBanner } from '../components/ScopeBanner';
import { PageLoading } from '../components/Spinner';
import { useI18n } from '../i18n';
import { DUE_GROUPS, type DueGroup, dueGroup, formatDateTime } from '../lib/time';
import { useAsync } from '../lib/useAsync';

function groupItems(items: DueItem[], courseId: number | 'all'): Array<{ group: DueGroup; items: DueItem[] }> {
  const now = Date.now();
  const out = new Map<DueGroup, DueItem[]>();
  for (const it of items) {
    if (courseId !== 'all' && it.courseId !== courseId) continue;
    const g = it.overdue ? 'overdue' : dueGroup(it.dueAt ?? it.opensAt, { now, deadline: it.dueAt !== null });
    out.set(g, [...(out.get(g) ?? []), it]);
  }
  return DUE_GROUPS.flatMap((g) => {
    const list = out.get(g);
    return list ? [{ group: g, items: list }] : [];
  });
}

function courseOptions(items: DueItem[]): Array<[number, string]> {
  const map = new Map<number, string>();
  for (const it of items) map.set(it.courseId, it.courseName);
  return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
}

function OtherCourses({ items }: { items: DueItem[] }) {
  const { t } = useI18n();
  if (items.length === 0) return null;
  return (
    <Card>
      <details className="disclosure">
        <summary>{t('courses.other', { count: items.length })}</summary>
        <p className="muted small">
          {t('due.otherHint')} <Link to="/courses">{t('due.manage')}</Link>
        </p>
        <ul className="due-list">
          {items.map((item) => (
            <DueRow key={`${item.source}-${item.kind}-${item.cmid ?? item.url}-${item.dueAt}`} item={item} />
          ))}
        </ul>
      </details>
    </Card>
  );
}

function DueFooter({ list }: { list: DueList }) {
  const { t, lang } = useI18n();
  const { checked, stale, checkedAt } = list.sweep;
  return (
    <div className="due-footer">
      <span>
        {checkedAt
          ? t('due.footer', { checked, time: formatDateTime(checkedAt, lang) })
          : t('due.footerNoTime', { checked })}
      </span>
      {stale > 0 && <span>{t('due.stale', { count: stale })}</span>}
      {list.truncated && <span>{t('due.truncated')}</span>}
    </div>
  );
}

export function DuePage() {
  const { t } = useI18n();
  const due = useAsync(() => getDue(14));
  const [courseId, setCourseId] = useState<number | 'all'>('all');
  const filterId = useId();

  const courses = useMemo(() => courseOptions(due.data?.items ?? []), [due.data]);
  const groups = useMemo(() => groupItems(due.data?.items ?? [], courseId), [due.data, courseId]);

  return (
    <>
      <PageHeader title={t('due.title')} desc={t('due.window')} />
      <ScopeBanner />
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
          </div>

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
                      key={`${item.source}-${item.kind}-${item.cmid ?? item.url}-${item.dueAt}`}
                      item={item}
                      showCourse={courseId === 'all'}
                    />
                  ))}
                </ul>
              </Card>
            ))
          )}
          <OtherCourses items={due.data.otherCourses} />
          <DueFooter list={due.data} />
        </>
      )}
    </>
  );
}
