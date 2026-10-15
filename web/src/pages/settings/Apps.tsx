import { useState } from 'react';
import { listApps, revokeApp } from '../../api/endpoints';
import type { AppGrant } from '../../api/types';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/EmptyState';
import { ErrorBox } from '../../components/ErrorBox';
import { PageLoading } from '../../components/Spinner';
import { useToast } from '../../components/Toast';
import { useI18n } from '../../i18n';
import { formatDate } from '../../lib/time';
import { useAsync } from '../../lib/useAsync';

export function AppsTab() {
  const { t, lang } = useI18n();
  const toast = useToast();
  const apps = useAsync(listApps);
  const [revoking, setRevoking] = useState<AppGrant | null>(null);

  return (
    <>
      <p className="muted">{t('apps.desc')}</p>
      <Card>
        {apps.loading && !apps.data && <PageLoading label={t('common.loading')} />}
        {apps.error != null && <ErrorBox error={apps.error} onRetry={apps.reload} />}
        {apps.data &&
          (apps.data.length === 0 ? (
            <EmptyState>{t('apps.empty')}</EmptyState>
          ) : (
            <ul className="rows">
              {apps.data.map((g) => (
                <li key={g.id} className="row">
                  <div className="row-main">
                    <div className="row-title">{g.clientName}</div>
                    <div className="row-meta">
                      <span>{g.scopes.includes('moodle:write') ? t('common.readWrite') : t('common.readOnly')}</span>
                      <span>
                        {t('apps.authorized')} {formatDate(g.createdAt, lang)}
                      </span>
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setRevoking(g)}>
                    {t('common.revoke')}
                  </Button>
                </li>
              ))}
            </ul>
          ))}
      </Card>
      <ConfirmDialog
        open={revoking !== null}
        title={t('apps.revokeTitle', { name: revoking?.clientName ?? '' })}
        description={t('apps.revokeDesc')}
        confirmLabel={t('common.revoke')}
        onClose={() => setRevoking(null)}
        onConfirm={async () => {
          if (!revoking) return;
          await revokeApp(revoking.id);
          toast.show(t('apps.revokedToast'));
          apps.setData((prev) => prev?.filter((x) => x.id !== revoking.id));
        }}
      />
    </>
  );
}
