import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { connectMail, disconnectMail } from '../../api/endpoints';
import type { MailConnection, MailInfo } from '../../api/types';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useToast } from '../../components/Toast';
import { useI18n } from '../../i18n';
import type { Translate } from '../../i18n/core';
import { errorText } from '../../lib/errors';
import { SOURCE_URL } from '../../lib/links';
import { canReconnectMail, isoOfMs, mailResultNotice, mailView, withoutMailParam } from '../../lib/mail';
import { formatDateTime } from '../../lib/time';
import { useSession } from '../../session';

const SELF_HOSTING_URL = `${SOURCE_URL}/blob/main/docs/self-hosting.md`;

/** Shows the outcome Google's redirect reported in `?mail=`, once, and removes it from the address bar. */
function useMailResultNotice() {
  const { t } = useI18n();
  const toast = useToast();
  useEffect(() => {
    const notice = mailResultNotice(new URLSearchParams(location.search).get('mail'));
    if (!notice) return;
    toast.show(t(notice.key), notice.tone);
    history.replaceState(history.state, '', withoutMailParam(location.href)); // later runs find no parameter
  }, [t, toast]);
}

/** Starts the Google authorization (new connection or reconnect); on success the browser leaves the console. */
function useConnectMail() {
  const { t } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      location.assign((await connectMail()).url);
    } catch (e) {
      setBusy(false);
      toast.show(e instanceof ApiError && e.status === 403 ? t('mail.full') : errorText(e, t), 'error');
    }
  };
  return { busy, start };
}

interface ActionProps {
  connecting: boolean;
  onConnect: () => void;
}

function ConnectedDetails({ connection }: { connection: MailConnection }) {
  const { t, lang } = useI18n();
  const lastUsed = isoOfMs(connection.lastUsedAt);
  return (
    <dl className="kv">
      <dt>{t('mail.address')}</dt>
      <dd>{connection.address}</dd>
      <dt>{t('mail.access')}</dt>
      <dd>{connection.canSend ? t('mail.canSend') : t('common.readOnly')}</dd>
      <dt>{t('mail.lastUsed')}</dt>
      <dd>{lastUsed ? formatDateTime(lastUsed, lang) : t('common.never')}</dd>
    </dl>
  );
}

function endText(reason: MailConnection['endReason'], idleDays: number | null, t: Translate): string {
  if (reason !== 'idle') return t('mail.endRevoked');
  return idleDays === null ? t('mail.endIdleNoDays') : t('mail.endIdle', { days: idleDays });
}

function InvalidNote({ connection, idleDays }: { connection: MailConnection; idleDays: number | null }) {
  const { t } = useI18n();
  return <p className="muted">{endText(connection.endReason, idleDays, t)}</p>;
}

function ConnectionCard({
  info,
  connection,
  connecting,
  onConnect,
  onDisconnect,
}: ActionProps & { info: MailInfo; connection: MailConnection; onDisconnect: () => void }) {
  const { t } = useI18n();
  const active = connection.status === 'active';
  return (
    <Card>
      {active ? (
        <ConnectedDetails connection={connection} />
      ) : (
        <InvalidNote connection={connection} idleDays={info.idleDays} />
      )}
      {active && !connection.canSend && <p className="muted small">{t('mail.needSend')}</p>}
      <div className="button-row">
        {canReconnectMail(connection) && (
          <Button variant="primary" busy={connecting} onClick={onConnect}>
            {t('mail.reconnect')}
          </Button>
        )}
        <Button variant="danger" onClick={onDisconnect}>
          {t('mail.disconnect')}
        </Button>
      </div>
    </Card>
  );
}

function ConnectCard({ info, connecting, onConnect }: ActionProps & { info: MailInfo }) {
  const { t } = useI18n();
  return (
    <Card>
      <p className="muted">{t('mail.desc')}</p>
      <div className="button-row">
        <Button variant="primary" busy={connecting} onClick={onConnect}>
          {t('mail.connect')}
        </Button>
      </div>
      <ul className="muted small">
        <li>{t('mail.unverified')}</li>
        {info.idleDays !== null && <li>{t('mail.idleNote', { days: info.idleDays })}</li>}
        {info.slotsLeft !== null && !info.hasSlot && <li>{t('mail.slotsLeft', { n: info.slotsLeft })}</li>}
      </ul>
    </Card>
  );
}

function FullCard() {
  const { t } = useI18n();
  return (
    <Card>
      <p className="muted">{t('mail.full')}</p>
      <a href={SELF_HOSTING_URL} target="_blank" rel="noopener noreferrer">
        {t('mail.selfHost')}
      </a>
    </Card>
  );
}

/** Settings → Mail: connect, reconnect or disconnect the Waseda mailbox (Google authorization). */
export function MailTab() {
  const { t } = useI18n();
  const toast = useToast();
  const { me, setMail } = useSession();
  const connect = useConnectMail();
  const [disconnecting, setDisconnecting] = useState(false);
  useMailResultNotice();

  const info = me.mail;
  if (!info) return null;
  const view = mailView(info);
  const connection = info.connection;
  const action = { connecting: connect.busy, onConnect: connect.start };

  return (
    <>
      {connection && (
        <ConnectionCard info={info} connection={connection} {...action} onDisconnect={() => setDisconnecting(true)} />
      )}
      {view === 'connect' && <ConnectCard info={info} {...action} />}
      {view === 'full' && <FullCard />}
      <ConfirmDialog
        open={disconnecting}
        title={t('mail.disconnectTitle')}
        description={t('mail.disconnectDesc')}
        confirmLabel={t('mail.disconnect')}
        onClose={() => setDisconnecting(false)}
        onConfirm={async () => {
          await disconnectMail();
          setMail({ ...info, connection: null });
          toast.show(t('mail.disconnectedToast'));
        }}
      />
    </>
  );
}
