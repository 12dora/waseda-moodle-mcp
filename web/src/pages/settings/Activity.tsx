import { useCallback, useEffect, useState } from 'react';
import { listActivity } from '../../api/endpoints';
import type { AuditEntry } from '../../api/types';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { ErrorBox } from '../../components/ErrorBox';
import { PageLoading } from '../../components/Spinner';
import { useI18n } from '../../i18n';
import { auditActionLabel, auditActorLabel } from '../../lib/audit';
import { formatDateTime } from '../../lib/time';

const PAGE = 50;

function ActivityTable({ entries }: { entries: AuditEntry[] }) {
  const { t, lang } = useI18n();
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">{t('activity.time')}</th>
            <th scope="col">{t('activity.source')}</th>
            <th scope="col">{t('activity.action')}</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td className="nowrap">
                <time dateTime={e.at}>{formatDateTime(e.at, lang)}</time>
              </td>
              <td>{auditActorLabel(e.actor, t)}</td>
              <td>{auditActionLabel(e.action, t)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ActivityTab() {
  const { t } = useI18n();
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  /** `before` = id of the oldest row shown (newest-first cursor). */
  const load = useCallback(async (before?: number) => {
    setLoading(true);
    setError(null);
    try {
      const page = await listActivity(PAGE, before);
      setEntries((prev) => (before !== undefined && prev ? [...prev, ...page] : page));
      setHasMore(page.length === PAGE);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const last = entries?.at(-1);

  return (
    <>
      <p className="muted">{t('activity.desc')}</p>
      <Card>
        {entries === null && loading && <PageLoading label={t('common.loading')} />}
        {entries?.length === 0 && <EmptyState>{t('activity.empty')}</EmptyState>}
        {entries && entries.length > 0 && <ActivityTable entries={entries} />}
        {error != null && <ErrorBox error={error} onRetry={() => load(last?.id)} />}
        {hasMore && last && (
          <div className="load-more">
            <Button busy={loading} onClick={() => load(last.id)}>
              {t('common.loadMore')}
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}
