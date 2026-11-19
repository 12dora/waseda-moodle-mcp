import { useState } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { decideMailRequest, getMe, listMailRequests } from '../api/endpoints';
import type { MailRequest, MailRequestAction, MailRequestList, MailRequestStatus } from '../api/types';
import { AsyncBlock } from '../components/AsyncBlock';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/Layout';
import { useToast } from '../components/Toast';
import { useI18n } from '../i18n';
import { serverMessageText } from '../lib/errors';
import { isoOfMs } from '../lib/mail';
import {
  MAIL_REQUEST_STATUSES,
  needsConfirmation,
  parseMailRequestStatus,
  rowActions,
  slotsText,
} from '../lib/mailRequests';
import { formatDateTime } from '../lib/time';
import { useAsync } from '../lib/useAsync';
import { useSession } from '../session';

function StatusFilter({ value, onChange }: { value: MailRequestStatus; onChange: (s: MailRequestStatus) => void }) {
  const { t } = useI18n();
  return (
    <fieldset className="segmented">
      <legend className="sr-only">{t('mail.admin.filter')}</legend>
      {MAIL_REQUEST_STATUSES.map((s) => (
        <label key={s}>
          <input type="radio" name="mail-request-status" checked={value === s} onChange={() => onChange(s)} />
          <span>{t(`mail.admin.status.${s}`)}</span>
        </label>
      ))}
    </fieldset>
  );
}

function ConnectionCell({ connection }: { connection: MailRequest['connection'] }) {
  const { t } = useI18n();
  if (!connection) return <span className="muted">{t('mail.status.none')}</span>;
  return (
    <>
      {connection.address}{' '}
      {connection.status === 'invalid' && <span className="badge badge-danger">{t('mail.admin.connEnded')}</span>}
    </>
  );
}

interface TableProps {
  busy: number | null;
  onAction: (request: MailRequest, action: MailRequestAction) => void;
}

interface RowProps extends TableProps {
  request: MailRequest;
}

function RequestRow({ request: r, busy, onAction }: RowProps) {
  const { t, lang } = useI18n();
  const requested = isoOfMs(r.requestedAt);
  return (
    <tr>
      <td>{r.fullname}</td>
      <td className="nowrap">{r.moodleUserId}</td>
      <td className="nowrap">{requested ? formatDateTime(requested, lang) : ''}</td>
      <td>
        <ConnectionCell connection={r.connection} />
      </td>
      <td>
        <div className="button-row">
          {rowActions(r.status).map(({ action, variant }) => (
            <Button
              key={action}
              size="sm"
              variant={variant}
              busy={busy === r.userId}
              disabled={busy !== null}
              onClick={() => onAction(r, action)}
            >
              {t(`mail.admin.${action}`)}
            </Button>
          ))}
        </div>
      </td>
    </tr>
  );
}

function RequestTable({ requests, busy, onAction }: TableProps & { requests: MailRequest[] }) {
  const { t } = useI18n();
  const head = ['name', 'moodleId', 'requested', 'connection', 'actions'] as const;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col">
                {t(`mail.admin.col.${h}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {requests.map((r) => (
            <RequestRow key={r.userId} request={r} busy={busy} onAction={onAction} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Applies operator decisions; `revoke` waits for confirmation because it also disconnects the user's mail. */
function useDecisions(reload: () => void, onDecided: () => void) {
  const { t } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState<number | null>(null);
  const [revoking, setRevoking] = useState<MailRequest | null>(null);

  const submit = async (userId: number, action: MailRequestAction) => {
    try {
      await decideMailRequest(userId, action);
      toast.show(t(`mail.admin.toast.${action}`), 'success');
    } catch (e) {
      toast.show(serverMessageText(e, t), 'error');
    } finally {
      // A refused decision usually means the list was stale, so it is reloaded either way.
      onDecided();
      reload();
    }
  };
  const decide = (request: MailRequest, action: MailRequestAction) => {
    if (needsConfirmation(action)) {
      setRevoking(request);
      return;
    }
    setBusy(request.userId);
    submit(request.userId, action).finally(() => setBusy(null));
  };
  const confirmRevoke = async () => {
    if (revoking) await submit(revoking.userId, 'revoke');
  };
  return { busy, decide, revoking, closeRevoke: () => setRevoking(null), confirmRevoke };
}

/** The sidebar badge shows the server's count; after every decision attempt it is re-read from /api/me. */
function usePendingCountAfterDecision() {
  const { setMail } = useSession();
  return () => {
    getMe()
      .then((me) => {
        if (me.mail) setMail(me.mail);
      })
      .catch(() => undefined);
  };
}

function RequestsCard({ status, data, ...rest }: { status: MailRequestStatus; data: MailRequestList } & TableProps) {
  const { t } = useI18n();
  const slots = slotsText(data.slots);
  return (
    <Card>
      <p className="muted">{t(slots.key, slots.vars)}</p>
      {data.requests.length === 0 ? (
        <EmptyState>{t(`mail.admin.empty.${status}`)}</EmptyState>
      ) : (
        <RequestTable requests={data.requests} {...rest} />
      )}
    </Card>
  );
}

function MailRequestsView() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const status = parseMailRequestStatus(params.get('status'));
  const list = useAsync(listMailRequests, status);
  const decisions = useDecisions(list.reload, usePendingCountAfterDecision());

  const onFilter = (next: MailRequestStatus) => setParams({ status: next }, { replace: true });

  return (
    <>
      <PageHeader
        title={t('mail.admin.title')}
        desc={t('mail.admin.desc')}
        actions={<StatusFilter value={status} onChange={onFilter} />}
      />
      <AsyncBlock state={list}>
        {(data) => <RequestsCard status={status} data={data} busy={decisions.busy} onAction={decisions.decide} />}
      </AsyncBlock>
      <ConfirmDialog
        open={decisions.revoking !== null}
        title={t('mail.admin.revokeTitle', { name: decisions.revoking?.fullname ?? '' })}
        description={t('mail.admin.revokeDesc')}
        confirmLabel={t('mail.admin.revoke')}
        onClose={decisions.closeRevoke}
        onConfirm={decisions.confirmRevoke}
      />
    </>
  );
}

/** Operator-only page: review who may connect Waseda mail. Everyone else gets the same fallback as an unknown route. */
export function MailRequestsPage() {
  const { me } = useSession();
  if (!me.isAdmin || !me.mail) return <Navigate to="/" replace />;
  return <MailRequestsView />;
}
