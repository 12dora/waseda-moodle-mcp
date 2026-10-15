import { Link, useNavigate } from 'react-router';
import { getDue, getTimetable, getUpdates, listActions } from '../api/endpoints';
import type { Me } from '../api/types';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { ClassLink } from '../components/ClassLink';
import { ClientCard } from '../components/ClientCard';
import { DueRow } from '../components/DueRow';
import { EmptyState } from '../components/EmptyState';
import { ErrorBox } from '../components/ErrorBox';
import { PageHeader } from '../components/Layout';
import { ScopeBanner } from '../components/ScopeBanner';
import { Spinner } from '../components/Spinner';
import { useI18n, useT } from '../i18n';
import { notesText } from '../lib/dayNotes';
import { outstandingItems } from '../lib/due';
import { formatDateTime } from '../lib/time';
import { todayJst } from '../lib/timetable';
import { useAsync } from '../lib/useAsync';
import { useSession } from '../session';

const PENDING_LIMIT = 100;

function ConnectionCard({ me }: { me: Me }) {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const cred = me.credential;
  const active = cred?.status === 'active';
  return (
    <Card
      title={t('overview.conn.title')}
      actions={
        <span className={`badge ${active ? 'badge-ok' : 'badge-danger'}`}>
          {active ? t('overview.conn.active') : t('overview.conn.invalid')}
        </span>
      }
    >
      {!cred && <p className="alert alert-error">{t('overview.conn.none')}</p>}
      {cred && !active && cred.lastError && <p className="alert alert-error">{cred.lastError}</p>}
      <dl className="kv">
        <dt>{t('overview.conn.account')}</dt>
        <dd>{me.user.fullname}</dd>
        {cred && (
          <>
            <dt>{t('overview.conn.via')}</dt>
            <dd>{t(`via.${cred.connectedVia}`)}</dd>
            <dt>{t('overview.conn.lastOk')}</dt>
            <dd>{cred.lastOkAt ? formatDateTime(cred.lastOkAt, lang) : t('common.never')}</dd>
            <dt>{t('overview.conn.token')}</dt>
            <dd className="mono">••••{cred.tokenHint}</dd>
          </>
        )}
      </dl>
      <Button variant={active ? 'secondary' : 'primary'} onClick={() => navigate('/connect')}>
        {t('overview.conn.reconnect')}
      </Button>
    </Card>
  );
}

function UpcomingCard() {
  const t = useT();
  const due = useAsync(() => getDue(14));
  const items = due.data ? outstandingItems(due.data.items) : [];
  return (
    <Card title={t('overview.due.title')} actions={<Link to="/due">{t('overview.due.viewAll')}</Link>}>
      {due.loading && <Spinner label={t('common.loading')} />}
      {due.error != null && <ErrorBox error={due.error} onRetry={due.reload} />}
      {due.data && items.length === 0 && <EmptyState>{t('due.empty')}</EmptyState>}
      {items.length > 0 && (
        <ul className="due-list">
          {items.slice(0, 5).map((item) => (
            <DueRow key={`${item.source}-${item.kind}-${item.cmid ?? item.url}-${item.dueAt}`} item={item} />
          ))}
        </ul>
      )}
      {due.data && due.data.otherCourses.length > 0 && (
        <p className="muted small">
          {t('overview.due.other', { count: due.data.otherCourses.length })}{' '}
          <Link to="/courses">{t('due.manage')}</Link>
        </p>
      )}
    </Card>
  );
}

function TodayCard() {
  const { t, lang } = useI18n();
  const today = useAsync(() => getTimetable(todayJst(), 1));
  const day = today.data?.days[0];
  const note = day ? notesText(day.notes, { t, lang }) : '';
  return (
    <Card title={t('overview.today.title')} actions={<Link to="/timetable">{t('nav.timetable')}</Link>}>
      {today.loading && <Spinner label={t('common.loading')} />}
      {today.error != null && <ErrorBox error={today.error} onRetry={today.reload} />}
      {note && <p className="tt-note">{note}</p>}
      {today.data && !day?.classes.length && <EmptyState>{t('overview.today.empty')}</EmptyState>}
      {day && day.classes.length > 0 && (
        <div className="stack tt-today">
          {day.classes.map((c) => (
            <ClassLink key={`${c.courseId}-${c.start}`} c={c} date={day.date} />
          ))}
        </div>
      )}
    </Card>
  );
}

function UpdatesCard() {
  const { t, lang } = useI18n();
  const updates = useAsync(() => getUpdates(7));
  const items = updates.data?.updates.slice(0, 5) ?? [];
  return (
    <Card title={t('overview.updates.title')}>
      {updates.loading && <Spinner label={t('common.loading')} />}
      {updates.error != null && <ErrorBox error={updates.error} onRetry={updates.reload} />}
      {updates.data?.updates.length === 0 && <EmptyState>{t('overview.updates.empty')}</EmptyState>}
      {items.length > 0 && (
        <ul className="rows update-list">
          {items.map((u) => (
            <li key={`${u.cmid}-${u.at}`} className="row">
              <div className="row-main">
                <a href={u.url} target="_blank" rel="noopener noreferrer" className="due-name">
                  {u.name}
                </a>
                <div className="row-meta">
                  <span className={`badge ${u.change === 'new' ? 'badge-ok' : ''}`}>
                    {t(u.change === 'new' ? 'overview.updates.new' : 'overview.updates.updated')}
                  </span>
                  <span>{u.courseName}</span>
                  <time dateTime={u.at}>{formatDateTime(u.at, lang)}</time>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function OverviewPage() {
  const t = useT();
  const { me } = useSession();
  const pending = useAsync(() => listActions('pending', PENDING_LIMIT));
  const count = pending.data?.length ?? 0;

  return (
    <>
      <PageHeader title={t('overview.title')} />
      <ScopeBanner />
      {count > 0 && (
        <div className="alert alert-info">
          <span>{t('overview.pending', { count: count >= PENDING_LIMIT ? `${PENDING_LIMIT}+` : count })}</span>
          <Link to="/actions">{t('overview.review')}</Link>
        </div>
      )}
      <div className="grid-2">
        <ConnectionCard me={me} />
        <UpcomingCard />
        <TodayCard />
        <UpdatesCard />
      </div>
      <ClientCard />
    </>
  );
}
