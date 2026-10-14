import type { CSSProperties } from 'react';
import type { TimetableClass, TimetableDay } from '../api/types';
import { useI18n } from '../i18n';
import { formatDay } from '../lib/time';
import { isoWeekday, PERIODS, periodSpan } from '../lib/timetable';

interface Block {
  key: string;
  style: CSSProperties;
  classes: TimetableClass[];
}

/** One grid block per (day, period range); classes sharing a slot are stacked inside it. */
function blocksFor(days: TimetableDay[]): Block[] {
  const map = new Map<string, Block>();
  days.forEach((day, col) => {
    for (const c of day.classes) {
      const { from, to } = periodSpan(c.start, c.end);
      const key = `${day.date}-${from}-${to}`;
      const block = map.get(key) ?? {
        key,
        style: { gridColumn: col + 2, gridRow: `${from + 1} / ${to + 2}` },
        classes: [],
      };
      block.classes.push(c);
      map.set(key, block);
    }
  });
  return [...map.values()];
}

export function ClassLink({ c }: { c: TimetableClass }) {
  return (
    <a href={c.url} target="_blank" rel="noopener noreferrer" className="tt-class">
      <span className="tt-time">
        {c.start}–{c.end}
      </span>
      <span className="tt-name">{c.courseName}</span>
      {(c.classroom || c.campus) && (
        <span className="tt-room">{[c.classroom, c.campus].filter(Boolean).join(' · ')}</span>
      )}
    </a>
  );
}

/** Desktop week view: period rows × day columns (Mon–Sat, plus Sunday only when it has classes). */
export function TimetableGrid({ days, today }: { days: TimetableDay[]; today: string }) {
  const { t, lang } = useI18n();
  const shown = days.filter((d) => isoWeekday(d.date) !== 7 || d.classes.length > 0);
  const style = { gridTemplateColumns: `4.5rem repeat(${shown.length}, minmax(0, 1fr))` };
  return (
    <div className="tt-grid" style={style}>
      <div className="tt-corner" />
      {shown.map((d, i) => (
        <div
          key={d.date}
          className={`tt-head${d.date === today ? ' today' : ''}`}
          style={{ gridColumn: i + 2, gridRow: 1 }}
          aria-current={d.date === today ? 'date' : undefined}
        >
          <span>{formatDay(d.date, lang)}</span>
          {d.note && <span className="tt-note">{d.note}</span>}
        </div>
      ))}
      {PERIODS.map((p) => (
        <div key={p.n} className="tt-period" style={{ gridColumn: 1, gridRow: p.n + 1 }}>
          <strong>{t('timetable.period', { n: p.n })}</strong>
          <span>{p.start}</span>
          <span>{p.end}</span>
        </div>
      ))}
      {shown.flatMap((d, i) =>
        PERIODS.map((p) => (
          <div
            key={`${d.date}-${p.n}`}
            className={`tt-cell${d.date === today ? ' today' : ''}`}
            style={{ gridColumn: i + 2, gridRow: p.n + 1 }}
          />
        )),
      )}
      {blocksFor(shown).map((b) => (
        <div key={b.key} className="tt-block" style={b.style}>
          {b.classes.map((c) => (
            <ClassLink key={`${c.courseId}-${c.start}`} c={c} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Mobile view: one card-like section per day. */
export function TimetableDayList({ days, today }: { days: TimetableDay[]; today: string }) {
  const { t, lang } = useI18n();
  return (
    <ol className="tt-days">
      {days.map((d) => (
        <li key={d.date} className={`tt-day${d.date === today ? ' today' : ''}`}>
          <div className="tt-day-head">
            <strong>{formatDay(d.date, lang)}</strong>
            {d.note && <span className="tt-note">{d.note}</span>}
          </div>
          {d.classes.length === 0 ? (
            <p className="muted small">{t('timetable.noClasses')}</p>
          ) : (
            d.classes.map((c) => <ClassLink key={`${c.courseId}-${c.start}`} c={c} />)
          )}
        </li>
      ))}
    </ol>
  );
}
