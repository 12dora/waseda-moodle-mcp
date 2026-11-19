import { useEffect, useState } from 'react';
import { disconnectMail } from '../../api/endpoints';
import type { MailConnection, MailInfo } from '../../api/types';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { MailAccessAction, MailReconnectButton } from '../../components/MailAccess';
import { useToast } from '../../components/Toast';
import { useI18n } from '../../i18n';
import type { Translate } from '../../i18n/core';
import {
  canReconnectMail,
  isoOfMs,
  isSetupView,
  mailNoteKey,
  mailResultNotice,
  mailView,
  type SetupView,
  withoutMailParam,
} from '../../lib/mail';
import { formatDateTime } from '../../lib/time';
import { useSession } from '../../session';

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
  onDisconnect,
}: {
  info: MailInfo;
  connection: MailConnection;
  onDisconnect: () => void;
}) {
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
        {canReconnectMail(connection) && <MailReconnectButton />}
        <Button variant="danger" onClick={onDisconnect}>
          {t('mail.disconnect')}
        </Button>
      </div>
    </Card>
  );
}

/** Views in which the user may still start a connection, so the idle rule and the free slots are worth a note. */
const NOTED_VIEWS: readonly SetupView[] = ['connect', 'apply', 'rejected'];

function SetupCard({ info, view }: { info: MailInfo; view: SetupView }) {
  const { t } = useI18n();
  const noted = NOTED_VIEWS.includes(view);
  return (
    <Card>
      <p className="muted">{t(mailNoteKey(view))}</p>
      <MailAccessAction info={info} view={view} />
      {noted && info.idleDays !== null && <p className="muted small">{t('mail.idleNote', { days: info.idleDays })}</p>}
      {noted && info.slotsLeft !== null && !info.hasSlot && (
        <p className="muted small">{t('mail.slotsLeft', { n: info.slotsLeft })}</p>
      )}
    </Card>
  );
}

/** Settings → Mail: apply for access, then connect, reconnect or disconnect the Waseda mailbox. */
export function MailTab() {
  const { t } = useI18n();
  const toast = useToast();
  const { me, setMail } = useSession();
  const [disconnecting, setDisconnecting] = useState(false);
  useMailResultNotice();

  const info = me.mail;
  if (!info) return null;
  const view = mailView(info);
  const connection = info.connection;

  return (
    <>
      {connection && <ConnectionCard info={info} connection={connection} onDisconnect={() => setDisconnecting(true)} />}
      {isSetupView(view) && <SetupCard info={info} view={view} />}
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
