import type { PeriodTime, TimetableDay } from '../api/types';
import { useI18n } from '../i18n';
import { notesText } from '../lib/dayNotes';
import { formatDay } from '../lib/time';
import { periodBlocks } from '../lib/timetable';
import { ClassLink, type OnEdit } from './ClassLink';

interface ViewProps {
  days: TimetableDay[];
  today: string;
  /** Leave out break notes per day (shown once above the view instead). */
  hideBreaks: boolean;
  onEdit: OnEdit;
}

function DayNotes({ day, hideBreaks }: { day: TimetableDay; hideBreaks: boolean }) {
  const { t, lang } = useI18n();
  const text = notesText(day.notes, { t, lang, skipBreaks: hideBreaks });
  return text ? <span className="tt-note">{text}</span> : null;
}

/** Desktop week view: period rows × day columns; overlapping classes share one block. */
export function TimetableGrid({ days, today, hideBreaks, onEdit, periods }: ViewProps & { periods: PeriodTime[] }) {
  const { t, lang } = useI18n();
  const style = { gridTemplateColumns: `4.5rem repeat(${days.length}, minmax(0, 1fr))` };
  return (
    <div className="tt-grid" style={style}>
      <div className="tt-corner" />
      {days.map((d, i) => (
        <div
          key={d.date}
          className={`tt-head${d.date === today ? ' today' : ''}`}
          style={{ gridColumn: i + 2, gridRow: 1 }}
          aria-current={d.date === today ? 'date' : undefined}
        >
          <span>{formatDay(d.date, lang)}</span>
          <DayNotes day={d} hideBreaks={hideBreaks} />
        </div>
      ))}
      {periods.map((p) => (
        <div key={p.period} className="tt-period" style={{ gridColumn: 1, gridRow: p.period + 1 }}>
          <strong>{t('timetable.period', { n: p.period })}</strong>
          <span>{p.start}</span>
          <span>{p.end}</span>
        </div>
      ))}
      {days.flatMap((d, i) =>
        periods.map((p) => (
          <div
            key={`${d.date}-${p.period}`}
            className={`tt-cell${d.date === today ? ' today' : ''}`}
            style={{ gridColumn: i + 2, gridRow: p.period + 1 }}
          />
        )),
      )}
      {days.flatMap((d, i) =>
        periodBlocks(d.classes).map((b) => (
          <div
            key={`${d.date}-${b.from}`}
            className="tt-block"
            style={{ gridColumn: i + 2, gridRow: `${b.from + 1} / ${b.to + 2}` }}
          >
            {b.classes.map((c) => (
              <ClassLink key={`${c.courseId}-${c.start}`} c={c} date={d.date} onEdit={onEdit} />
            ))}
          </div>
        )),
      )}
    </div>
  );
}

/** Mobile view: one card-like section per day. */
export function TimetableDayList({ days, today, hideBreaks, onEdit }: ViewProps) {
  const { t, lang } = useI18n();
  return (
    <ol className="tt-days">
      {days.map((d) => (
        <li key={d.date} className={`tt-day${d.date === today ? ' today' : ''}`}>
          <div className="tt-day-head">
            <strong>{formatDay(d.date, lang)}</strong>
            <DayNotes day={d} hideBreaks={hideBreaks} />
          </div>
          {d.classes.length === 0 ? (
            <p className="muted small">{t('timetable.noClasses')}</p>
          ) : (
            d.classes.map((c) => <ClassLink key={`${c.courseId}-${c.start}`} c={c} date={d.date} onEdit={onEdit} />)
          )}
        </li>
      ))}
    </ol>
  );
}
