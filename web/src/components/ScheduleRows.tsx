import { useId } from 'react';
import type { PeriodTime } from '../api/types';
import { useI18n } from '../i18n';
import { CLASSROOM_MAX, emptyRow, MAX_ROWS, rowInvalid, type SlotRow } from '../lib/scheduleForm';
import { weekdayName } from '../lib/time';
import { Button } from './Button';

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

interface RowProps {
  row: SlotRow;
  index: number;
  periods: PeriodTime[];
  onChange: (row: SlotRow | null) => void; // null removes the row
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

function SlotRowEditor({ row, index, periods, onChange }: RowProps) {
  const { t, lang } = useI18n();
  const errorId = useId();
  const invalid = rowInvalid(row);
  const n = index + 1;
  return (
    <li className="slot-row">
      <select
        className="input select"
        aria-label={t('timetable.edit.weekday', { n })}
        value={row.weekday}
        onChange={(e) => onChange({ ...row, weekday: Number(e.target.value) })}
      >
        {WEEKDAYS.map((w) => (
          <option key={w} value={w}>
            {weekdayName(w, lang)}
          </option>
        ))}
      </select>
      <PeriodSelect
        value={row.from}
        periods={periods}
        label={t('timetable.edit.from', { n })}
        onChange={(from) => onChange({ ...row, from })}
      />
      <span aria-hidden="true">–</span>
      <PeriodSelect
        value={row.to}
        periods={periods}
        label={t('timetable.edit.to', { n })}
        errorId={invalid ? errorId : undefined}
        onChange={(to) => onChange({ ...row, to })}
      />
      <input
        className="input slot-room"
        aria-label={t('timetable.edit.room', { n })}
        placeholder={t('timetable.edit.roomPlaceholder')}
        maxLength={CLASSROOM_MAX}
        value={row.room}
        onChange={(e) => onChange({ ...row, room: e.target.value })}
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
      {invalid && (
        <span id={errorId} className="field-error slot-error">
          {t('timetable.edit.rangeError')}
        </span>
      )}
    </li>
  );
}

/** Weekly slots: weekday + period range + optional room, up to MAX_ROWS rows (at least one). */
export function ScheduleRows({
  rows,
  periods,
  onChange,
}: {
  rows: SlotRow[];
  periods: PeriodTime[];
  onChange: (rows: SlotRow[]) => void;
}) {
  const { t } = useI18n();
  const update = (i: number, next: SlotRow | null) => {
    const kept = next ? rows.map((r, j) => (j === i ? next : r)) : rows.filter((_, j) => j !== i);
    onChange(kept.length > 0 ? kept : [emptyRow()]);
  };
  return (
    <div className="stack">
      <ul className="slot-rows">
        {rows.map((row, i) => (
          <SlotRowEditor key={row.key} row={row} index={i} periods={periods} onChange={(r) => update(i, r)} />
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
