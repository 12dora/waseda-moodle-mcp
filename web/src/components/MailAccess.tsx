import { useState } from 'react';
import { ApiError } from '../api/client';
import { connectMail, requestMailAccess } from '../api/endpoints';
import type { MailInfo } from '../api/types';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/core';
import { SOURCE_URL } from '../lib/links';
import type { SetupView } from '../lib/mail';
import { useSession } from '../session';
import { Button } from './Button';
import { ConfirmDialog } from './ConfirmDialog';
import { useToast } from './Toast';

const SELF_HOSTING_URL = `${SOURCE_URL}/blob/main/docs/self-hosting.md`;

const GOOGLE_STEPS: readonly MessageKey[] = ['mail.step1', 'mail.step2', 'mail.step3'];

/** A 403 means the server refused this user for a reason the dialog can name; anything else is shown as it is. */
function refusal(e: unknown, text: string): unknown {
  return e instanceof ApiError && e.status === 403 ? new Error(text) : e;
}

/** What to expect on Google's "has not verified this app" screens, shown right before the authorization starts. */
function GoogleSteps() {
  const { t } = useI18n();
  return (
    <>
      <p className="muted">{t('mail.warnWhy')}</p>
      <ol className="muted">
        {GOOGLE_STEPS.map((k) => (
          <li key={k}>{t(k)}</li>
        ))}
      </ol>
    </>
  );
}

interface DialogProps {
  open: boolean;
  onClose: () => void;
}

/** The one place that explains Google's screens; "Continue" starts the authorization and leaves the console. */
function MailConnectDialog({ open, onClose }: DialogProps) {
  const { t } = useI18n();
  const start = async () => {
    try {
      location.assign((await connectMail()).url);
    } catch (e) {
      throw refusal(e, t('mail.connectRefused'));
    }
  };
  return (
    <ConfirmDialog
      open={open}
      title={t('mail.connect')}
      confirmLabel={t('mail.continueGoogle')}
      variant="primary"
      onClose={onClose}
      onConfirm={start}
    >
      <GoogleSteps />
    </ConfirmDialog>
  );
}

/** Why approval is needed, then the request itself; operators and approved users are answered `approved` at once. */
function ApplyDialog({ open, onClose, info }: DialogProps & { info: MailInfo }) {
  const { t } = useI18n();
  const toast = useToast();
  const { setMail } = useSession();
  const submit = async () => {
    try {
      const { access } = await requestMailAccess();
      setMail({ ...info, access });
      toast.show(t(access === 'approved' ? 'mail.requestApproved' : 'mail.requestSent'), 'success');
    } catch (e) {
      throw refusal(e, t('mail.full'));
    }
  };
  return (
    <ConfirmDialog
      open={open}
      title={t('mail.applyTitle')}
      confirmLabel={t('mail.applySubmit')}
      variant="primary"
      onClose={onClose}
      onConfirm={submit}
    >
      <p className="muted">{t('mail.applyBody1')}</p>
      <p className="muted">{t('mail.applyBody2')}</p>
    </ConfirmDialog>
  );
}

type DialogName = 'apply' | 'connect';

const TRIGGERS: Partial<Record<SetupView, { label: MessageKey; dialog: DialogName }>> = {
  apply: { label: 'mail.apply', dialog: 'apply' },
  rejected: { label: 'mail.applyAgain', dialog: 'apply' },
  connect: { label: 'mail.connect', dialog: 'connect' },
};

/**
 * The primary action of a state without a connection (Overview and Settings → Mail share it): apply, apply again,
 * connect (with Google's steps), or the self-hosting link when no slot is left. Pending has nothing to do.
 */
export function MailAccessAction({ info, view }: { info: MailInfo; view: SetupView }) {
  const { t } = useI18n();
  const [dialog, setDialog] = useState<DialogName | null>(null);
  const close = () => setDialog(null);
  const trigger = TRIGGERS[view];
  return (
    <>
      {trigger && (
        <div className="button-row">
          <Button variant="primary" onClick={() => setDialog(trigger.dialog)}>
            {t(trigger.label)}
          </Button>
        </div>
      )}
      {view === 'full' && (
        <a href={SELF_HOSTING_URL} target="_blank" rel="noopener noreferrer">
          {t('mail.selfHost')}
        </a>
      )}
      <ApplyDialog open={dialog === 'apply'} onClose={close} info={info} />
      <MailConnectDialog open={dialog === 'connect'} onClose={close} />
    </>
  );
}

/** Reconnect for a broken or read-only connection: opens the same dialog as a new connection. */
export function MailReconnectButton() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        {t('mail.reconnect')}
      </Button>
      <MailConnectDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
