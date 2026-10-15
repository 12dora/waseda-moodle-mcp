import { useState } from 'react';
import { getTimetable } from '../api/endpoints';
import type { Timetable } from '../api/types';
import { AsyncBlock } from '../components/AsyncBlock';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import type { EditTarget } from '../components/ClassLink';
import { PageHeader } from '../components/Layout';
import { ScheduleEditor } from '../components/ScheduleEditor';
import { ScopeBanner } from '../components/ScopeBanner';
import { TimetableDayList, TimetableGrid } from '../components/TimetableGrid';
import { UnknownList, UnscheduledLists } from '../components/TimetableLists';
import { useI18n } from '../i18n';
import { noteText, sharedBreaks } from '../lib/dayNotes';
import { formatDay } from '../lib/time';
import { addDays, todayJst, visibleDays, weekStart } from '../lib/timetable';
import { useAsync } from '../lib/useAsync';

const loadWeek = (start: string) => getTimetable(start, 7);

function WeekView({ data, today, onEdit }: { data: Timetable; today: string; onEdit: (c: EditTarget) => void }) {
  const { t, lang } = useI18n();
  const days = visibleDays(data.days);
  const breaks = sharedBreaks(days);
  const hideBreaks = breaks !== null;
  return (
    <Card className="tt-card">
      {breaks && <p className="tt-notice">{breaks.map((n) => noteText(n, { t, lang })).join(' · ')}</p>}
      {data.approximate && <p className="muted small">{t('timetable.approximate')}</p>}
      <TimetableGrid
        days={days}
        today={today}
        periods={data.periodTimes.standard}
        hideBreaks={hideBreaks}
        onEdit={onEdit}
      />
      <TimetableDayList days={data.days} today={today} hideBreaks={hideBreaks} onEdit={onEdit} />
    </Card>
  );
}

function WeekNav({ week, today, onChange }: { week: string; today: string; onChange: (week: string) => void }) {
  const { t } = useI18n();
  return (
    <div className="button-row">
      <Button size="sm" onClick={() => onChange(addDays(week, -7))} aria-label={t('timetable.prev')}>
        ‹
      </Button>
      <Button size="sm" disabled={week === weekStart(today)} onClick={() => onChange(weekStart(today))}>
        {t('timetable.today')}
      </Button>
      <Button size="sm" onClick={() => onChange(addDays(week, 7))} aria-label={t('timetable.next')}>
        ›
      </Button>
    </div>
  );
}

export function TimetablePage() {
  const { t, lang } = useI18n();
  const today = todayJst();
  const [week, setWeek] = useState(() => weekStart(today));
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const tt = useAsync(loadWeek, week);

  return (
    <>
      <PageHeader
        title={t('timetable.title')}
        desc={`${formatDay(week, lang)} – ${formatDay(addDays(week, 6), lang)}`}
        actions={<WeekNav week={week} today={today} onChange={setWeek} />}
      />
      <ScopeBanner />
      <AsyncBlock state={tt}>
        {(data) => (
          <>
            <WeekView data={data} today={today} onEdit={setEditing} />
            <UnscheduledLists items={data.onDemand} onEdit={setEditing} />
            <UnknownList items={data.unknown} onEdit={setEditing} />
            {editing && (
              <ScheduleEditor
                key={editing.courseId}
                target={editing}
                timetable={data}
                onClose={() => setEditing(null)}
                onSaved={() => {
                  setEditing(null);
                  tt.reload();
                }}
              />
            )}
          </>
        )}
      </AsyncBlock>
    </>
  );
}
