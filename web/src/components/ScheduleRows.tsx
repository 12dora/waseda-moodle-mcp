import { useId } from 'react';
import type { PeriodTime, Timetable } from '../api/types';
import { type MessageKey, useI18n } from '../i18n';
import {
  CLASSROOM_MAX,
  emptyRow,
  MAX_ROWS,
  nightAllowed,
  normalizeRow,
  type RowError,
  rowErrors,
  type SlotRow,
} from '../lib/scheduleForm';
import { weekdayName } from '../lib/time';
import { Button } from './Button';

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

type PeriodTimes = Timetable['periodTimes'];

const ERROR_TEXT: Record<RowError, MessageKey> = {
  range: 'timetable.edit.rangeError',
  overlap: 'timetable.edit.overlapError',
  room: 'timetable.edit.roomError',
};

interface RowProps {
  row: SlotRow;
  index: number;
  periods: PeriodTimes;
  error: RowError | null;
  onChange: (row: SlotRow | null) => void; // null removes the row
}

/** Period options on the row's clock: the evening times replace periods 6–7 on a WBS evening row. */
function rowPeriods(row: SlotRow, { standard, evening }: PeriodTimes): PeriodTime[] {
  if (!row.night) return standard;
  return standard.map((p) => evening.find((e) => e.period === p.period) ?? p);
}

function PeriodSelect({
  value,
  periods,
  label,
  errorId,
  onChange,
}: {
  value: number;
  periods: PeriodTime[];
  label: string;
  errorId?: string;
  onChange: (n: number) => void;
}) {
  const { t } = useI18n();
  return (
    <select
      className="input select"
      aria-label={label}
      aria-invalid={errorId ? true : undefined}
      aria-describedby={errorId}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    >
      {periods.map((p) => (
        <option key={p.period} value={p.period}>
          {`${t('timetable.period', { n: p.period })} ${p.start}–${p.end}`}
        </option>
      ))}
    </select>
  );
}

function SlotRowEditor({ row, index, periods, error, onChange }: RowProps) {
  const { t, lang } = useI18n();
  const errorId = useId();
  const n = index + 1;
  const options = rowPeriods(row, periods);
  const set = (patch: Partial<SlotRow>) => onChange(normalizeRow({ ...row, ...patch }));
  const timeErrorId = error === 'range' || error === 'overlap' ? errorId : undefined;
  return (
    <li className="slot-row">
      <select
        className="input select"
        aria-label={t('timetable.edit.weekday', { n })}
        aria-invalid={error === 'overlap' ? true : undefined}
        aria-describedby={error === 'overlap' ? errorId : undefined}
        value={row.weekday}
        onChange={(e) => set({ weekday: Number(e.target.value) })}
      >
        {WEEKDAYS.map((w) => (
          <option key={w} value={w}>
            {weekdayName(w, lang)}
          </option>
        ))}
      </select>
      <PeriodSelect
        value={row.from}
        periods={options}
        label={t('timetable.edit.from', { n })}
        onChange={(from) => set({ from })}
      />
      <span aria-hidden="true">–</span>
      <PeriodSelect
        value={row.to}
        periods={options}
        label={t('timetable.edit.to', { n })}
        errorId={timeErrorId}
        onChange={(to) => set({ to })}
      />
      <label className="slot-night" title={t('timetable.edit.eveningHint')}>
        <input
          type="checkbox"
          aria-label={t('timetable.edit.eveningRow', { n })}
          checked={row.night}
          disabled={!nightAllowed(row)}
          onChange={(e) => set({ night: e.target.checked })}
        />
        <span aria-hidden="true">{t('timetable.edit.evening')}</span>
      </label>
      <input
        className="input slot-room"
        aria-label={t('timetable.edit.room', { n })}
        aria-invalid={error === 'room' ? true : undefined}
        aria-describedby={error === 'room' ? errorId : undefined}
        placeholder={t('timetable.edit.roomPlaceholder')}
        value={row.room}
        onChange={(e) => set({ room: e.target.value })}
      />
      <button
        type="button"
        className="slot-remove"
        aria-label={t('timetable.edit.remove', { n })}
        title={t('timetable.edit.removeShort')}
        onClick={() => onChange(null)}
      >
        <span aria-hidden="true">×</span>
      </button>
      {error && (
        <span id={errorId} className="field-error slot-error">
          {t(ERROR_TEXT[error], { max: CLASSROOM_MAX })}
        </span>
      )}
    </li>
  );
}

/** Weekly slots: weekday + period range (+ evening clock) + optional room, up to MAX_ROWS rows (at least one). */
export function ScheduleRows({
  rows,
  periods,
  onChange,
}: {
  rows: SlotRow[];
  periods: PeriodTimes;
  onChange: (rows: SlotRow[]) => void;
}) {
  const { t } = useI18n();
  const errors = rowErrors(rows);
  const update = (i: number, next: SlotRow | null) => {
    const kept = next ? rows.map((r, j) => (j === i ? next : r)) : rows.filter((_, j) => j !== i);
    onChange(kept.length > 0 ? kept : [emptyRow()]);
  };
  return (
    <div className="stack">
      <ul className="slot-rows">
        {rows.map((row, i) => (
          <SlotRowEditor
            key={row.key}
            row={row}
            index={i}
            periods={periods}
            error={errors[i] ?? null}
            onChange={(r) => update(i, r)}
          />
        ))}
      </ul>
      {rows.length < MAX_ROWS && (
        <div>
          <Button size="sm" variant="ghost" onClick={() => onChange([...rows, emptyRow()])}>
            {t('timetable.edit.add')}
          </Button>
        </div>
      )}
    </div>
  );
}
