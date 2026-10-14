import type { DueItem } from '../api/types';
import { useI18n } from '../i18n';
import { formatDateTime } from '../lib/time';

function Status({ item }: { item: DueItem }) {
  const { t } = useI18n();
  if (item.closed) return <span className="badge">{t('due.closed')}</span>;
  if (item.overdue) return <span className="badge badge-danger">{t('due.group.overdue')}</span>;
  if (item.notOpenYet) return <span className="badge">{t('due.notOpen')}</span>;
  return null;
}

export function DueRow({ item, showCourse = true }: { item: DueItem; showCourse?: boolean }) {
  const { t, lang } = useI18n();
  const when = item.dueAt ?? item.opensAt;
  const label = item.dueAt
    ? formatDateTime(item.dueAt, lang, { deadline: true })
    : t('due.opens', { time: formatDateTime(item.opensAt, lang) });
  return (
    <li className={`due-row${item.closed ? ' row-muted' : ''}`}>
      <div className="due-main">
        <a href={item.url} target="_blank" rel="noopener noreferrer" className="due-name">
          {item.name}
        </a>
        <div className="due-meta">
          <span className="tag">{t(`kind.${item.kind}`)}</span>
          {showCourse && <span className="due-course">{item.courseName}</span>}
        </div>
      </div>
      <div className="due-when">
        <time dateTime={when ?? undefined} className={item.overdue && !item.closed ? 'text-danger' : undefined}>
          {label}
        </time>
        <Status item={item} />
      </div>
    </li>
  );
}
