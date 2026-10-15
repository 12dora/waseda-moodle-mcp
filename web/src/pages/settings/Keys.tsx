import { type FormEvent, useId, useState } from 'react';
import { createKey, listKeys, revokeKey } from '../../api/endpoints';
import type { ApiKey, Scope } from '../../api/types';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { CopyField } from '../../components/CopyField';
import { Dialog } from '../../components/Dialog';
import { EmptyState } from '../../components/EmptyState';
import { ErrorBox } from '../../components/ErrorBox';
import { PageLoading } from '../../components/Spinner';
import { useToast } from '../../components/Toast';
import { useI18n } from '../../i18n';
import { errorText } from '../../lib/errors';
import { formatDate, formatDateTime } from '../../lib/time';
import { useAsync } from '../../lib/useAsync';

export function KeysTab() {
  const { t, lang } = useI18n();
  const toast = useToast();
  const keys = useAsync(listKeys);
  const nameId = useId();
  const [name, setName] = useState('');
  const [write, setWrite] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    setCreating(true);
    setCreateError(null);
    try {
      const scopes: Scope[] = write ? ['moodle:read', 'moodle:write'] : ['moodle:read'];
      const res = await createKey(n, scopes);
      keys.setData((prev) => [res.key, ...(prev ?? [])]);
      setSecret(res.secret);
      setName('');
      setWrite(false);
    } catch (err) {
      setCreateError(errorText(err, t));
    } finally {
      setCreating(false);
    }
  };

  const accessLabel = (scopes: Scope[]) =>
    scopes.includes('moodle:write') ? t('common.readWrite') : t('common.readOnly');

  return (
    <>
      <p className="muted">{t('keys.desc')}</p>

      <Card title={t('keys.create')}>
        <form className="form-row" onSubmit={onCreate}>
          <div className="field">
            <label htmlFor={nameId} className="field-label">
              {t('keys.name')}
            </label>
            <input
              id={nameId}
              className="input"
              value={name}
              maxLength={60}
              required
              placeholder={t('keys.namePlaceholder')}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <fieldset className="field segmented">
            <legend className="field-label">{t('keys.access')}</legend>
            <label>
              <input type="radio" name="key-access" checked={!write} onChange={() => setWrite(false)} />
              <span>{t('common.readOnly')}</span>
            </label>
            <label>
              <input type="radio" name="key-access" checked={write} onChange={() => setWrite(true)} />
              <span>{t('common.readWrite')}</span>
            </label>
          </fieldset>
          <Button type="submit" variant="primary" busy={creating} disabled={!name.trim()}>
            {t('keys.create')}
          </Button>
        </form>
        {createError && (
          <p className="field-error" role="alert">
            {createError}
          </p>
        )}
      </Card>

      <Card>
        {keys.loading && !keys.data && <PageLoading label={t('common.loading')} />}
        {keys.error != null && <ErrorBox error={keys.error} onRetry={keys.reload} />}
        {keys.data &&
          (keys.data.length === 0 ? (
            <EmptyState>{t('keys.empty')}</EmptyState>
          ) : (
            <ul className="rows">
              {keys.data.map((k) => (
                <li key={k.id} className={`row${k.revokedAt ? ' row-muted' : ''}`}>
                  <div className="row-main">
                    <div className="row-title">
                      {k.name} {k.revokedAt && <span className="badge">{t('keys.revoked')}</span>}
                    </div>
                    <div className="row-meta">
                      <span className="mono">{k.prefix}…</span>
                      <span>{accessLabel(k.scopes)}</span>
                      <span>
                        {t('keys.created')} {formatDate(k.createdAt, lang)}
                      </span>
                      <span>
                        {t('keys.lastUsed')} {k.lastUsedAt ? formatDateTime(k.lastUsedAt, lang) : t('common.never')}
                      </span>
                    </div>
                  </div>
                  {!k.revokedAt && (
                    <Button size="sm" variant="ghost" onClick={() => setRevoking(k)}>
                      {t('common.revoke')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ))}
      </Card>

      <Dialog
        open={secret !== null}
        onClose={() => setSecret(null)}
        dismissible={false}
        title={t('keys.secretTitle')}
        footer={
          <Button variant="primary" onClick={() => setSecret(null)}>
            {t('common.close')}
          </Button>
        }
      >
        <p className="muted">{t('keys.secretDesc')}</p>
        {secret && <CopyField label={t('keys.key')} value={secret} />}
      </Dialog>

      <ConfirmDialog
        open={revoking !== null}
        title={t('keys.revokeTitle', { name: revoking?.name ?? '' })}
        description={t('keys.revokeDesc')}
        confirmLabel={t('common.revoke')}
        onClose={() => setRevoking(null)}
        onConfirm={async () => {
          if (!revoking) return;
          await revokeKey(revoking.id);
          toast.show(t('keys.revokedToast'));
          keys.reload();
        }}
      />
    </>
  );
}
