import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { deleteAccount, getCourses, patchSettings } from '../api/endpoints';
import type { Course, SettingsPatch, UiLang, WriteMode } from '../api/types';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { ErrorBox } from '../components/ErrorBox';
import { LangSelect } from '../components/LangSelect';
import { PageHeader } from '../components/Layout';
import { Spinner } from '../components/Spinner';
import { useToast } from '../components/Toast';
import { type MessageKey, useI18n } from '../i18n';
import { errorText } from '../lib/errors';
import { useAsync } from '../lib/useAsync';
import { useSession } from '../session';

const WRITE_MODES: ReadonlyArray<{ mode: WriteMode; label: MessageKey; desc: MessageKey }> = [
  { mode: 'off', label: 'settings.write.off', desc: 'settings.write.offDesc' },
  { mode: 'chat', label: 'settings.write.chat', desc: 'settings.write.chatDesc' },
  { mode: 'console', label: 'settings.write.console', desc: 'settings.write.consoleDesc' },
];

/** Current courses plus any hidden course that is no longer current, so it can be shown again. */
async function loadCourses(hiddenIds: number[]): Promise<Course[]> {
  const current = await getCourses('inprogress');
  const known = new Set(current.map((c) => c.id));
  const missing = new Set(hiddenIds.filter((id) => !known.has(id)));
  if (missing.size === 0) return current;
  const all = await getCourses('all');
  return [...current, ...all.filter((c) => missing.has(c.id))];
}

export function SettingsPage() {
  const { t, setUiLang } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const { me, setSettings } = useSession();
  const settings = me.user.settings;
  const courses = useAsync(() => loadCourses(settings.hiddenCourseIds));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (location.hash === '#hidden' && courses.data) document.getElementById('hidden')?.scrollIntoView();
  }, [location.hash, courses.data]);

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

  const toggleHidden = (id: number, hide: boolean) => {
    const set = new Set(settings.hiddenCourseIds);
    if (hide) set.add(id);
    else set.delete(id);
    void save({ hiddenCourseIds: [...set] });
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

      <Card title={t('settings.hidden.title')} id="hidden">
        <p className="muted">{t('settings.hidden.desc')}</p>
        {courses.loading && !courses.data && <Spinner label={t('common.loading')} />}
        {courses.error != null && <ErrorBox error={courses.error} onRetry={courses.reload} />}
        {courses.data &&
          (courses.data.length === 0 ? (
            <EmptyState>{t('settings.hidden.empty')}</EmptyState>
          ) : (
            <ul className="check-list">
              {courses.data.map((c) => {
                const hidden = settings.hiddenCourseIds.includes(c.id);
                return (
                  <li key={c.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={hidden}
                        disabled={saving}
                        onChange={(e) => toggleHidden(c.id, e.target.checked)}
                      />
                      <span>{c.name}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          ))}
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
