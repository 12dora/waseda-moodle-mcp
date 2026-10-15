import { useState } from 'react';
import { createCalendar, deleteCalendar, getCalendar } from '../api/endpoints';
import type { CalendarStatus } from '../api/types';
import { type MessageKey, useI18n } from '../i18n';
import { errorText } from '../lib/errors';
import { formatDateTime } from '../lib/time';
import { useAsync } from '../lib/useAsync';
import { Button } from './Button';
import { Card } from './Card';
import { ConfirmDialog } from './ConfirmDialog';
import { CopyField } from './CopyField';
import { ErrorBox } from './ErrorBox';
import { Spinner } from './Spinner';
import { useToast } from './Toast';

type Confirm = 'rotate' | 'off';

const CONFIRMS: Record<Confirm, { title: MessageKey; desc: MessageKey; label: MessageKey }> = {
  rotate: { title: 'calendar.rotateTitle', desc: 'calendar.rotateDesc', label: 'calendar.rotate' },
  off: { title: 'calendar.offTitle', desc: 'calendar.offDesc', label: 'calendar.off' },
};

const HOW_TO: readonly MessageKey[] = [
  'calendar.howGoogle',
  'calendar.howApple',
  'calendar.howIphone',
  'calendar.howOutlook',
];

const OFF: CalendarStatus = { enabled: false, createdAt: null, lastFetchAt: null };

function FeedDetails({ status, url }: { status: CalendarStatus; url: string | null }) {
  const { t, lang } = useI18n();
  return (
    <>
      {url && (
        <div>
          <CopyField label={t('calendar.url')} value={url} />
          <p className="muted small">{t('calendar.once')}</p>
        </div>
      )}
      {status.lastFetchAt && (
        <dl className="kv">
          <dt>{t('calendar.lastFetch')}</dt>
          <dd>{formatDateTime(status.lastFetchAt, lang)}</dd>
        </dl>
      )}
      <ul className="muted small">
        {HOW_TO.map((k) => (
          <li key={k}>{t(k)}</li>
        ))}
      </ul>
    </>
  );
}

/** Secret ICS feed of deadlines + timetable (contract §17.2); the URL is only visible right after create/rotate. */
export function CalendarCard() {
  const { t } = useI18n();
  const toast = useToast();
  const status = useAsync(getCalendar);
  const [url, setUrl] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const issue = async () => {
    const res = await createCalendar();
    setUrl(res.url);
    status.reload(); // background refresh; the URL is shown even if this fails
  };

  const onCreate = async () => {
    setCreating(true);
    try {
      await issue();
    } catch (e) {
      toast.show(errorText(e, t), 'error');
    } finally {
      setCreating(false);
    }
  };

  const turnOff = async () => {
    await deleteCalendar();
    setUrl(null);
    status.setData(() => OFF);
    toast.show(t('calendar.offToast'));
  };

  // A freshly issued URL means the feed is on, whatever the (possibly stale or failed) status GET says.
  const view: CalendarStatus | undefined = url ? { ...(status.data ?? OFF), enabled: true } : status.data;
  const enabled = view?.enabled === true;
  const dialog = confirm ? CONFIRMS[confirm] : null;

  return (
    <Card title={t('calendar.title')}>
      <p className="muted">{t('calendar.desc')}</p>
      {status.loading && !view && <Spinner label={t('common.loading')} />}
      {status.error != null && <ErrorBox error={status.error} onRetry={status.reload} />}
      {view && enabled && <FeedDetails status={view} url={url} />}
      {view && (
        <div className="button-row">
          {enabled ? (
            <>
              <Button onClick={() => setConfirm('rotate')}>{t('calendar.rotate')}</Button>
              <Button variant="danger" onClick={() => setConfirm('off')}>
                {t('calendar.off')}
              </Button>
            </>
          ) : (
            <Button variant="primary" busy={creating} onClick={onCreate}>
              {t('calendar.create')}
            </Button>
          )}
        </div>
      )}
      <ConfirmDialog
        open={dialog !== null}
        title={dialog ? t(dialog.title) : ''}
        description={dialog ? t(dialog.desc) : undefined}
        confirmLabel={dialog ? t(dialog.label) : ''}
        onClose={() => setConfirm(null)}
        onConfirm={confirm === 'off' ? turnOff : issue}
      />
    </Card>
  );
}
