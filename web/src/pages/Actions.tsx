import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { approveAction, cancelAction, listActions } from '../api/endpoints';
import type { ActionRecord } from '../api/types';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { ErrorBox } from '../components/ErrorBox';
import { notifyActionsChanged, PageHeader } from '../components/Layout';
import { PageLoading } from '../components/Spinner';
import { useToast } from '../components/Toast';
import { useI18n } from '../i18n';
import { errorText } from '../lib/errors';
import { PENDING_LIMIT } from '../lib/pending';
import { formatDateTime } from '../lib/time';
import { useAsync } from '../lib/useAsync';

const STATUS_BADGE: Record<ActionRecord['status'], string> = {
  pending: 'badge-warn',
  executing: 'badge-warn',
  executed: 'badge-ok',
  cancelled: '',
  expired: '',
  failed: 'badge-danger',
};

function Lines({ lines, className }: { lines: string[]; className: string }) {
  if (lines.length === 0) return null;
  return (
    <ul className={className}>
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

interface PendingProps {
  action: ActionRecord;
  focused: boolean;
  busy: string | null;
  onDecide: (action: ActionRecord, approve: boolean) => void;
}

function PendingItem({ action: a, focused, busy, onDecide }: PendingProps) {
  const { t, lang } = useI18n();
  return (
    <li id={`action-${a.id}`} className={`action-item${focused ? ' focused' : ''}`}>
      <div className="action-head">
        <span className="tag">{t(`actions.kind.${a.kind}`)}</span>
        <strong className="action-title">{a.title}</strong>
      </div>
      <Lines lines={a.details} className="action-details" />
      <Lines lines={a.warnings} className="action-warnings" />
      <div className="row-meta">
        <span>{t('actions.requestedBy', { source: a.source })}</span>
        <span>{t('actions.expires', { time: formatDateTime(a.expiresAt, lang) })}</span>
      </div>
      <div className="button-row">
        <Button variant="primary" busy={busy === a.id} disabled={busy !== null} onClick={() => onDecide(a, true)}>
          {t('actions.approve')}
        </Button>
        <Button variant="secondary" disabled={busy !== null} onClick={() => onDecide(a, false)}>
          {t('actions.reject')}
        </Button>
      </div>
    </li>
  );
}

function HistoryRow({ action: a, focused }: { action: ActionRecord; focused: boolean }) {
  const { t, lang } = useI18n();
  const at = a.executedAt ?? a.createdAt;
  const note = a.error ?? a.result;
  return (
    <li id={`action-${a.id}`} className={`row${focused ? ' focused' : ''}`}>
      <div className="row-main">
        <div className="row-title">{a.title}</div>
        <div className="row-meta">
          <span>{t(`actions.kind.${a.kind}`)}</span>
          <span>{a.source}</span>
          <time dateTime={at}>{formatDateTime(at, lang)}</time>
        </div>
        {note && <div className={a.error ? 'text-danger small' : 'muted small'}>{note}</div>}
      </div>
      <span className={`badge ${STATUS_BADGE[a.status]}`}>{t(`actions.status.${a.status}`)}</span>
    </li>
  );
}

export function ActionsPage() {
  const { t } = useI18n();
  const toast = useToast();
  const [params] = useSearchParams();
  const focus = params.get('focus');
  const pending = useAsync(() => listActions('pending', PENDING_LIMIT));
  const history = useAsync(() => listActions(undefined, 50));
  const [busy, setBusy] = useState<string | null>(null);

  const ready = pending.data !== undefined;
  useEffect(() => {
    if (!focus || !ready) return;
    document.getElementById(`action-${focus}`)?.scrollIntoView({ block: 'center' });
  }, [focus, ready]);

  const decide = async (a: ActionRecord, approve: boolean) => {
    setBusy(a.id);
    try {
      if (approve) {
        const res = await approveAction(a.id);
        const ok = res.status === 'executed';
        toast.show(ok ? t('actions.approvedToast') : res.message, ok ? 'success' : 'error');
      } else {
        await cancelAction(a.id);
        toast.show(t('actions.rejectedToast'));
      }
    } catch (e) {
      toast.show(errorText(e, t), 'error');
    } finally {
      setBusy(null);
      pending.reload();
      history.reload();
      notifyActionsChanged();
    }
  };

  const done = (history.data ?? []).filter((a) => a.status !== 'pending');

  return (
    <>
      <PageHeader title={t('actions.title')} />

      <Card title={t('actions.pending')}>
        {pending.loading && !pending.data && <PageLoading label={t('common.loading')} />}
        {pending.error != null && <ErrorBox error={pending.error} onRetry={pending.reload} />}
        {pending.data?.length === 0 && <EmptyState>{t('actions.emptyPending')}</EmptyState>}
        {pending.data && pending.data.length > 0 && (
          <ul className="actions-list">
            {pending.data.map((a) => (
              <PendingItem key={a.id} action={a} focused={a.id === focus} busy={busy} onDecide={decide} />
            ))}
          </ul>
        )}
      </Card>

      <Card title={t('actions.history')}>
        {history.loading && !history.data && <PageLoading label={t('common.loading')} />}
        {history.error != null && <ErrorBox error={history.error} onRetry={history.reload} />}
        {history.data && done.length === 0 && <EmptyState>{t('actions.emptyHistory')}</EmptyState>}
        {done.length > 0 && (
          <ul className="rows">
            {done.map((a) => (
              <HistoryRow key={a.id} action={a} focused={a.id === focus} />
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
