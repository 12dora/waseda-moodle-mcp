import { useState } from 'react';
import { patchSettings } from '../api/endpoints';
import type { ScheduleOverride, Timetable } from '../api/types';
import { type MessageKey, useI18n } from '../i18n';
import { formValid, initialForm, type ScheduleForm, type ScheduleMode, toOverride } from '../lib/scheduleForm';
import { useSession } from '../session';
import { Button } from './Button';
import type { EditTarget } from './ClassLink';
import { Dialog } from './Dialog';
import { ErrorBox } from './ErrorBox';
import { ScheduleRows } from './ScheduleRows';
import { useToast } from './Toast';

const MODES: ReadonlyArray<{ mode: ScheduleMode; label: MessageKey }> = [
  { mode: 'slots', label: 'timetable.edit.weekly' },
  { mode: 'on-demand', label: 'timetable.onDemand' },
  { mode: 'none', label: 'timetable.noFixedTime' },
];

function ModePicker({ value, onChange }: { value: ScheduleMode; onChange: (mode: ScheduleMode) => void }) {
  const { t } = useI18n();
  return (
    <fieldset className="field segmented">
      <legend className="field-label">{t('timetable.edit.mode')}</legend>
      {MODES.map((m) => (
        <label key={m.mode}>
          <input type="radio" name="schedule-mode" checked={value === m.mode} onChange={() => onChange(m.mode)} />
          <span>{t(m.label)}</span>
        </label>
      ))}
    </fieldset>
  );
}

/** Saves one course's override (null = back to automatic) and keeps the session settings in sync. */
function useSaveOverride(courseId: number, onSaved: () => void) {
  const { t } = useI18n();
  const toast = useToast();
  const { setSettings } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const save = async (override: ScheduleOverride | null) => {
    setBusy(true);
    setError(null);
    try {
      const res = await patchSettings({ scheduleOverrides: { [String(courseId)]: override } });
      setSettings(res.settings);
      toast.show(t('common.saved'));
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return { save, busy, error };
}

/**
 * Set or correct a course's class time (contract §15.4). Mount with `key={courseId}` so the form starts from
 * the course's current override, or from what the loaded timetable shows.
 */
export function ScheduleEditor({
  target,
  timetable,
  onClose,
  onSaved,
}: {
  target: EditTarget;
  timetable: Timetable;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const { me } = useSession();
  const override = me.user.settings.scheduleOverrides[String(target.courseId)];
  const [form, setForm] = useState<ScheduleForm>(() => initialForm(target.courseId, { override, timetable }));
  const { save, busy, error } = useSaveOverride(target.courseId, onSaved);
  const valid = formValid(form);

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      title={t('timetable.edit.title', { course: target.courseName })}
      footer={
        <>
          {override && (
            <Button variant="ghost" className="dialog-footer-start" disabled={busy} onClick={() => save(null)}>
              {t('timetable.edit.useAuto')}
            </Button>
          )}
          <Button disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" busy={busy} disabled={!valid} onClick={() => save(toOverride(form))}>
            {t('courses.save')}
          </Button>
        </>
      }
    >
      <ModePicker value={form.mode} onChange={(mode) => setForm({ ...form, mode })} />
      {form.mode === 'slots' && (
        <ScheduleRows
          rows={form.rows}
          periods={timetable.periodTimes.standard}
          onChange={(rows) => setForm({ ...form, rows })}
        />
      )}
      {error != null && <ErrorBox error={error} />}
    </Dialog>
  );
}
