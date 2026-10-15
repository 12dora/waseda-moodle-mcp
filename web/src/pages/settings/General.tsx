import { useState } from 'react';
import { patchSettings } from '../../api/endpoints';
import type { SettingsPatch, UiLang, WriteMode } from '../../api/types';
import { Card } from '../../components/Card';
import { LangSelect } from '../../components/LangSelect';
import { useToast } from '../../components/Toast';
import { type MessageKey, useI18n } from '../../i18n';
import { errorText } from '../../lib/errors';
import { useSession } from '../../session';

const WRITE_MODES: ReadonlyArray<{ mode: WriteMode; label: MessageKey; desc: MessageKey }> = [
  { mode: 'off', label: 'settings.write.off', desc: 'settings.write.offDesc' },
  { mode: 'chat', label: 'settings.write.chat', desc: 'settings.write.chatDesc' },
  { mode: 'console', label: 'settings.write.console', desc: 'settings.write.consoleDesc' },
];

/** Settings → General: write mode and interface language. */
export function GeneralTab() {
  const { t, setUiLang } = useI18n();
  const toast = useToast();
  const { me, setSettings } = useSession();
  const settings = me.user.settings;
  const [saving, setSaving] = useState(false);

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
    </>
  );
}
