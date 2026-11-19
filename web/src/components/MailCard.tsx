import { Link } from 'react-router';
import type { MailInfo } from '../api/types';
import { useI18n } from '../i18n';
import { isSetupView, mailStatusKey, mailView } from '../lib/mail';
import { Card } from './Card';
import { MailAccessAction, MailReconnectButton } from './MailAccess';

/** Overview card for the Waseda mailbox: one status line and the action the current state calls for. */
export function MailCard({ info }: { info: MailInfo }) {
  const { t } = useI18n();
  const view = mailView(info);
  const connection = info.connection;
  const access = connection?.canSend ? t('mail.canSend') : t('common.readOnly');
  return (
    <Card title={t('mail.overviewTitle')} actions={connection && <Link to="/settings/mail">{t('mail.manage')}</Link>}>
      <p className="muted">{t(mailStatusKey(view), { address: connection?.address ?? '', access })}</p>
      {isSetupView(view) && <MailAccessAction info={info} view={view} />}
      {view === 'invalid' && (
        <div className="button-row">
          <MailReconnectButton />
        </div>
      )}
    </Card>
  );
}
