import { Link } from 'react-router';
import type { MailInfo } from '../api/types';
import { useI18n } from '../i18n';
import { isSetupView, mailStatusKey, mailView } from '../lib/mail';
import { MailAccessAction, MailReconnectButton } from './MailAccess';

/** The Waseda mailbox inside the Overview connections card: one status line and the action the current state calls for. */
export function MailRow({ info }: { info: MailInfo }) {
  const { t } = useI18n();
  const view = mailView(info);
  const connection = info.connection;
  const access = connection?.canSend ? t('mail.canSend') : t('common.readOnly');
  return (
    <div className="conn-section">
      <div className="conn-head">
        <h3 className="conn-title">{t('mail.overviewTitle')}</h3>
        {connection && <Link to="/settings/mail">{t('mail.manage')}</Link>}
      </div>
      <p className="muted">{t(mailStatusKey(view), { address: connection?.address ?? '', access })}</p>
      {isSetupView(view) && <MailAccessAction info={info} view={view} />}
      {view === 'invalid' && (
        <div className="button-row">
          <MailReconnectButton />
        </div>
      )}
    </div>
  );
}
