import type { DueItem } from '../../api/types';
import { type MessageKey, useI18n } from '../../i18n';
import { groupByBucket } from '../../lib/courses';
import { Card } from '../Card';
import { DueRow } from '../DueRow';

type Bucket = ReturnType<typeof groupByBucket>[number]['bucket'];

const BUCKET_TITLE: Record<Bucket, MessageKey> = {
  overdue: 'courses.view.bucket.overdue',
  todo: 'courses.view.bucket.todo',
  draft: 'courses.view.bucket.draft',
  done: 'courses.view.bucket.done',
};

const itemKey = (it: DueItem) => `${it.source}-${it.kind}-${it.cmid ?? it.url}-${it.dueAt}`;

/** This course's items in status groups; submitted rows are struck through by DueRow. */
export function AssignmentsCard({ items }: { items: DueItem[] }) {
  const { t } = useI18n();
  const groups = groupByBucket(items);
  return (
    <Card title={t('courses.view.assignments')}>
      {groups.length === 0 && <p className="muted">{t('courses.view.noAssignments')}</p>}
      {groups.map(({ bucket, items: list }) => (
        <section key={bucket} className="cv-group">
          <h3 className={`cv-group-title${bucket === 'overdue' ? ' text-danger' : ''}`}>
            {t(BUCKET_TITLE[bucket])} <span className="muted">{list.length}</span>
          </h3>
          <ul className="due-list">
            {list.map((it) => (
              <DueRow key={itemKey(it)} item={it} showCourse={false} />
            ))}
          </ul>
        </section>
      ))}
    </Card>
  );
}
