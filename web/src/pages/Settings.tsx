import { useState } from 'react';
import { useNavigate } from 'react-router';
import { deleteAccount, patchSettings } from '../api/endpoints';
import type { SettingsPatch, UiLang, WriteMode } from '../api/types';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { LangSelect } from '../components/LangSelect';
import { PageHeader } from '../components/Layout';
import { useToast } from '../components/Toast';
import { type MessageKey, useI18n } from '../i18n';
import { errorText } from '../lib/errors';
import { useSession } from '../session';

const WRITE_MODES: ReadonlyArray<{ mode: WriteMode; label: MessageKey; desc: MessageKey }> = [
  { mode: 'off', label: 'settings.write.off', desc: 'settings.write.offDesc' },
  { mode: 'chat', label: 'settings.write.chat', desc: 'settings.write.chatDesc' },
  { mode: 'console', label: 'settings.write.console', desc: 'settings.write.consoleDesc' },
];

export function SettingsPage() {
  const { t, setUiLang } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const { me, setSettings } = useSession();
  const settings = me.user.settings;
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const save = async (patch: SettingsPatch) => {
    setSaving(true);
    try {
      const res = await patchSettings(patch);
      setSettings(res.settings);
      if (patch.uiLang) setUiLang(res.settings.uiLang);
      toast.show(t('common.saved'));
    } catch (e) {
      toast.show(errorText(e, t), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader title={t('settings.title')} />

      <Card title={t('settings.write.title')}>
        <fieldset className="radio-group" disabled={saving}>
          <legend className="muted">{t('settings.write.desc')}</legend>
          {WRITE_MODES.map((m) => (
            <label key={m.mode} className="radio-card">
              <input
                type="radio"
                name="write-mode"
                checked={settings.writeMode === m.mode}
                onChange={() => save({ writeMode: m.mode })}
              />
              <span>
                <strong>{t(m.label)}</strong>
                <span className="muted">{t(m.desc)}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </Card>

      <Card title={t('settings.lang.title')}>
        <LangSelect showLabel={false} disabled={saving} onChange={(v: UiLang) => save({ uiLang: v })} />
      </Card>

      <Card title={t('settings.account.title')} className="card-danger">
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
