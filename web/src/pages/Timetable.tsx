import { useState } from 'react';
import { getTimetable } from '../api/endpoints';
import type { TimetableCourseRef } from '../api/types';
import { AsyncBlock } from '../components/AsyncBlock';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { PageHeader } from '../components/Layout';
import { ScopeBanner } from '../components/ScopeBanner';
import { TimetableDayList, TimetableGrid } from '../components/TimetableGrid';
import { useI18n } from '../i18n';
import { formatDay } from '../lib/time';
import { addDays, todayJst, weekStart } from '../lib/timetable';
import { useAsync } from '../lib/useAsync';

const loadWeek = (start: string) => getTimetable(start, 7);

function CourseRefs({ title, desc, items }: { title: string; desc?: string; items: TimetableCourseRef[] }) {
  if (items.length === 0) return null;
  return (
    <Card title={title}>
      {desc && <p className="muted small">{desc}</p>}
      <ul className="rows">
        {items.map((c) => (
          <li key={c.courseId} className="row">
            <a href={c.url} target="_blank" rel="noopener noreferrer">
              {c.courseName}
            </a>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function TimetablePage() {
  const { t, lang } = useI18n();
  const today = todayJst();
  const [week, setWeek] = useState(() => weekStart(today));
  const tt = useAsync(loadWeek, week);
  const isThisWeek = week === weekStart(today);

  return (
    <>
      <PageHeader
        title={t('timetable.title')}
        desc={`${formatDay(week, lang)} – ${formatDay(addDays(week, 6), lang)}`}
        actions={
          <div className="button-row">
            <Button size="sm" onClick={() => setWeek(addDays(week, -7))} aria-label={t('timetable.prev')}>
              ‹
            </Button>
            <Button size="sm" disabled={isThisWeek} onClick={() => setWeek(weekStart(today))}>
              {t('timetable.today')}
            </Button>
            <Button size="sm" onClick={() => setWeek(addDays(week, 7))} aria-label={t('timetable.next')}>
              ›
            </Button>
          </div>
        }
      />
      <ScopeBanner />
      <AsyncBlock state={tt}>
        {(data) => (
          <>
            <Card className="tt-card">
              <TimetableGrid days={data.days} today={today} />
              <TimetableDayList days={data.days} today={today} />
            </Card>
            <CourseRefs title={t('timetable.onDemand')} items={data.onDemand} />
            <CourseRefs title={t('timetable.unknown')} desc={t('timetable.unknownDesc')} items={data.unknown} />
          </>
        )}
      </AsyncBlock>
    </>
  );
}
