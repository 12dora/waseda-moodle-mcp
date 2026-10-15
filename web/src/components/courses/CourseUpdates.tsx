import type { CourseUpdate } from '../../api/types';
import { useI18n } from '../../i18n';
import { formatDateTime } from '../../lib/time';
import { Card } from '../Card';

function UpdateRow({ update }: { update: CourseUpdate }) {
  const { t, lang } = useI18n();
  const isNew = update.change === 'new';
  return (
    <li className="row">
      <div className="row-main">
        <a href={update.url} target="_blank" rel="noopener noreferrer" className="due-name">
          {update.name}
        </a>
        <div className="row-meta">
          <span className={isNew ? 'badge badge-ok' : 'badge'}>
            {t(isNew ? 'courses.view.new' : 'courses.view.updated')}
          </span>
          <time dateTime={update.at}>{formatDateTime(update.at, lang)}</time>
        </div>
      </div>
    </li>
  );
}

/** Last 14 days of this course's changes, newest first (server order). */
export function UpdatesCard({ updates }: { updates: CourseUpdate[] }) {
  const { t } = useI18n();
  return (
    <Card title={t('courses.view.updates')}>
      {updates.length === 0 ? (
        <p className="muted">{t('courses.view.noUpdates')}</p>
      ) : (
        <ul className="rows">
          {updates.map((u) => (
            <UpdateRow key={`${u.cmid}-${u.at}`} update={u} />
          ))}
        </ul>
      )}
    </Card>
  );
}
