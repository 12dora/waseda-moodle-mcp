import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { getDue, listActions } from '../api/endpoints';
import type { Me } from '../api/types';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { CopyField } from '../components/CopyField';
import { DueRow } from '../components/DueRow';
import { EmptyState } from '../components/EmptyState';
import { ErrorBox } from '../components/ErrorBox';
import { PageHeader } from '../components/Layout';
import { Spinner } from '../components/Spinner';
import { type MessageKey, useI18n, useT } from '../i18n';
import { formatDateTime } from '../lib/time';
import { useAsync } from '../lib/useAsync';
import { useConfig, useSession } from '../session';

const PENDING_LIMIT = 100;

type ClientTab = 'claude' | 'code' | 'other';
const TABS: ReadonlyArray<{ id: ClientTab; key: MessageKey }> = [
  { id: 'claude', key: 'overview.client.claude' },
  { id: 'code', key: 'overview.client.claudeCode' },
  { id: 'other', key: 'overview.client.other' },
];

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
  return (
    <Card title={t('overview.due.title')} actions={<Link to="/due">{t('overview.due.viewAll')}</Link>}>
      {due.loading && <Spinner label={t('common.loading')} />}
      {due.error != null && <ErrorBox error={due.error} onRetry={due.reload} />}
      {due.data?.items.length === 0 && <EmptyState>{t('due.empty')}</EmptyState>}
      {due.data && due.data.items.length > 0 && (
        <ul className="due-list">
          {due.data.items.slice(0, 5).map((item) => (
            <DueRow key={`${item.kind}-${item.cmid ?? item.url}-${item.dueAt}`} item={item} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function ClientPanels({ tab, mcpUrl }: { tab: ClientTab; mcpUrl: string }) {
  const t = useT();
  const command = `claude mcp add --transport http waseda-moodle ${mcpUrl} --header "Authorization: Bearer <API_KEY>"`;
  const panel = (id: ClientTab) => ({
    role: 'tabpanel',
    id: `panel-${id}`,
    'aria-labelledby': `tab-${id}`,
    hidden: tab !== id,
    className: 'tab-panel',
  });
  return (
    <>
      <div {...panel('claude')}>
        <ol className="steps">
          <li>{t('overview.client.claude1')}</li>
          <li>{t('overview.client.claude2')}</li>
          <li>{t('overview.client.claude3')}</li>
        </ol>
      </div>
      <div {...panel('code')}>
        <p>{t('overview.client.codeDesc')}</p>
        <CopyField label={t('overview.client.claudeCode')} multiline value={command} />
        <Link className="btn btn-secondary btn-sm" to="/keys">
          {t('overview.client.createKey')}
        </Link>
      </div>
      <div {...panel('other')}>
        <p>{t('overview.client.otherDesc')}</p>
        <pre className="code">Authorization: Bearer &lt;API_KEY&gt;</pre>
      </div>
    </>
  );
}

function ClientCard() {
  const t = useT();
  const config = useConfig();
  const [tab, setTab] = useState<ClientTab>('claude');

  const move = (delta: number) => {
    const i = TABS.findIndex((x) => x.id === tab);
    const next = TABS[(i + delta + TABS.length) % TABS.length];
    if (!next) return;
    setTab(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  };

  return (
    <Card title={t('overview.client.title')}>
      <CopyField label={t('overview.client.mcpUrl')} value={config.mcpUrl} />
      <div className="tabs" role="tablist" aria-label={t('overview.client.title')}>
        {TABS.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            id={`tab-${x.id}`}
            aria-selected={tab === x.id}
            aria-controls={`panel-${x.id}`}
            tabIndex={tab === x.id ? 0 : -1}
            className={`tab${tab === x.id ? ' active' : ''}`}
            onClick={() => setTab(x.id)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') move(1);
              if (e.key === 'ArrowLeft') move(-1);
            }}
          >
            {t(x.key)}
          </button>
        ))}
      </div>
      <ClientPanels tab={tab} mcpUrl={config.mcpUrl} />
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
      {count > 0 && (
        <div className="alert alert-info">
          <span>{t('overview.pending', { count: count >= PENDING_LIMIT ? `${PENDING_LIMIT}+` : count })}</span>
          <Link to="/actions">{t('overview.review')}</Link>
        </div>
      )}
      <div className="grid-2">
        <ConnectionCard me={me} />
        <UpcomingCard />
      </div>
      <ClientCard />
    </>
  );
}
