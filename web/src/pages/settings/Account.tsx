import { useState } from 'react';
import { useNavigate } from 'react-router';
import { deleteAccount } from '../../api/endpoints';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useToast } from '../../components/Toast';
import { useT } from '../../i18n';
import { useSession } from '../../session';

/** Settings → Account: signed-in account and account deletion (danger zone). */
export function AccountTab() {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const { me } = useSession();
  const [deleting, setDeleting] = useState(false);

  return (
    <>
      <Card className="card-danger">
        <dl className="kv">
          <dt>{t('overview.conn.account')}</dt>
          <dd>{me.user.fullname}</dd>
        </dl>
        <p className="muted">{t('settings.account.deleteDesc')}</p>
        <Button variant="danger" onClick={() => setDeleting(true)}>
          {t('settings.account.delete')}
        </Button>
      </Card>

      <ConfirmDialog
        open={deleting}
        title={t('settings.account.deleteTitle')}
        description={t('settings.account.deleteDesc')}
        confirmLabel={t('settings.account.delete')}
        onClose={() => setDeleting(false)}
        onConfirm={async () => {
          await deleteAccount();
          toast.show(t('settings.account.deleted'));
          navigate('/connect', { replace: true });
        }}
      />
    </>
  );
}
