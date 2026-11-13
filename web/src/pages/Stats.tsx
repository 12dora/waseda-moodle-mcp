import { useMemo } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { getUsageStats } from '../api/endpoints';
import type { UsageStats } from '../api/types';
import { AsyncBlock } from '../components/AsyncBlock';
import { Card } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/Layout';
import { BarChart } from '../components/stats/BarChart';
import { ClientsTable, DailyTable, ToolsTable } from '../components/stats/StatsTables';
import {
  ActionsTable,
  ChannelsTable,
  ConnectsTable,
  CredentialsTable,
  FailuresTable,
  LatencyTable,
  PagesTable,
  RenewalFailuresTable,
  RetentionTable,
} from '../components/stats/UsageTables';
import { useI18n } from '../i18n';
import {
  hasUsage,
  hourBars,
  parseStatsRange,
  peakOf,
  STATS_RANGES,
  type StatsRange,
  shortDay,
  sumOf,
} from '../lib/stats';
import { useAsync } from '../lib/useAsync';
import { useSession } from '../session';

type Fmt = (n: number) => string;

function RangePicker({ value, onChange }: { value: StatsRange; onChange: (days: StatsRange) => void }) {
  const { t } = useI18n();
  return (
    <fieldset className="segmented stat-range">
      <legend className="sr-only">{t('stats.range')}</legend>
      {STATS_RANGES.map((d) => (
        <label key={d}>
          <input type="radio" name="stats-range" checked={value === d} onChange={() => onChange(d)} />
          <span>{t('stats.rangeDays', { days: d })}</span>
        </label>
      ))}
    </fieldset>
  );
}

function KpiTiles({ stats, fmt }: { stats: UsageStats; fmt: Fmt }) {
  const { t } = useI18n();
  const { users, channels } = stats;
  const tiles: Array<[string, number]> = [
    [t('stats.kpi.total'), users.total],
    [t('stats.kpi.new', { days: stats.days }), users.newInRange],
    [t('stats.kpi.today'), channels.today.total],
    [t('stats.kpi.week'), channels.week.total],
    [t('stats.kpi.month'), channels.month.total],
  ];
  return (
    <dl className="kpi-grid">
      {tiles.map(([label, value]) => (
        <div key={label} className="kpi">
          <dt className="kpi-label">{label}</dt>
          <dd className="kpi-value">{fmt(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function DailyCharts({ stats, fmt }: { stats: UsageStats; fmt: Fmt }) {
  const { t } = useI18n();
  const { daily, days } = stats;
  const peak = peakOf(daily.map((d) => d.activeAll));
  const calls = sumOf(daily.map((d) => d.calls));
  const failed = sumOf(daily.map((d) => d.errors));
  const callsSummary = { calls: fmt(calls), failed: fmt(failed) };
  return (
    <>
      <Card
        title={t('stats.dau.title')}
        actions={<span className="muted small">{t('stats.dau.peak', { count: fmt(peak) })}</span>}
      >
        <BarChart
          data={daily.map((d) => ({ day: d.day, value: d.activeAll }))}
          label={t('stats.dau.aria', { days, peak: fmt(peak) })}
          format={fmt}
          tooltip={(i) => {
            const d = daily[i];
            return d ? t('stats.dau.tip', { day: shortDay(d.day), count: fmt(d.activeAll) }) : '';
          }}
        />
      </Card>
      <Card
        title={t('stats.calls.title')}
        actions={<span className="muted small">{t('stats.calls.total', callsSummary)}</span>}
      >
        <BarChart
          data={daily.map((d) => ({ day: d.day, value: d.calls }))}
          label={t('stats.calls.aria', { days, ...callsSummary })}
          format={fmt}
          tooltip={(i) => {
            const d = daily[i];
            return d ? t('stats.calls.tip', { day: shortDay(d.day), calls: fmt(d.calls), failed: fmt(d.errors) }) : '';
          }}
        />
        <details className="disclosure">
          <summary>{t('stats.daily.show')}</summary>
          <DailyTable daily={daily} fmt={fmt} />
        </details>
      </Card>
    </>
  );
}

function HoursCard({ title, values, fmt }: { title: string; values: number[]; fmt: Fmt }) {
  const { t } = useI18n();
  const bars = hourBars(values);
  const peak = peakOf(bars.map((b) => b.value));
  return (
    <Card title={title}>
      <BarChart
        data={bars}
        label={t('stats.hours.aria', { title, peak: fmt(peak) })}
        format={fmt}
        tooltip={(i) => t('stats.hours.tip', { hour: bars[i]?.day ?? '', count: fmt(bars[i]?.value ?? 0) })}
      />
    </Card>
  );
}

function CalendarCard({ stats, fmt }: { stats: UsageStats; fmt: Fmt }) {
  const { t } = useI18n();
  const { daily, days } = stats;
  const fetches = fmt(sumOf(daily.map((d) => d.icsFetches)));
  return (
    <Card
      title={t('stats.calendar.title')}
      actions={<span className="muted small">{t('stats.calendar.total', { fetches })}</span>}
    >
      <BarChart
        data={daily.map((d) => ({ day: d.day, value: d.icsFetches }))}
        label={t('stats.calendar.aria', { days, fetches })}
        format={fmt}
        tooltip={(i) => {
          const d = daily[i];
          if (!d) return '';
          return t('stats.calendar.tip', { day: shortDay(d.day), fetches: fmt(d.icsFetches), feeds: fmt(d.icsFeeds) });
        }}
      />
    </Card>
  );
}

function ToolBreakdowns({ stats, fmt }: { stats: UsageStats; fmt: Fmt }) {
  const { t } = useI18n();
  return (
    <>
      <Card title={t('stats.failures.title')}>
        <FailuresTable tools={stats.tools} fmt={fmt} />
      </Card>
      <Card title={t('stats.latency.title')}>
        <LatencyTable tools={stats.tools} fmt={fmt} />
      </Card>
    </>
  );
}

function OperationsCards({ stats, fmt }: { stats: UsageStats; fmt: Fmt }) {
  const { t } = useI18n();
  const { credentials } = stats;
  return (
    <>
      <Card title={t('stats.actions.title')}>
        <ActionsTable actions={stats.actions} fmt={fmt} />
      </Card>
      <div className="grid-2">
        <Card title={t('stats.credentials.title')}>
          <CredentialsTable stats={stats} fmt={fmt} />
        </Card>
        <Card title={t('stats.connects.title')}>
          <ConnectsTable connects={credentials.connects} fmt={fmt} />
        </Card>
        <Card title={t('stats.renewFailures.title')}>
          <RenewalFailuresTable failures={credentials.failures} fmt={fmt} />
        </Card>
        <CalendarCard stats={stats} fmt={fmt} />
      </div>
      <Card title={t('stats.retention.title')}>
        <RetentionTable retention={stats.retention} fmt={fmt} />
      </Card>
    </>
  );
}

function StatsBody({ stats }: { stats: UsageStats }) {
  const { t, lang } = useI18n();
  const fmt = useMemo(() => {
    const nf = new Intl.NumberFormat(lang);
    return (n: number) => nf.format(n);
  }, [lang]);

  if (!hasUsage(stats)) {
    return (
      <Card>
        <EmptyState>{t('stats.empty')}</EmptyState>
      </Card>
    );
  }
  return (
    <>
      <KpiTiles stats={stats} fmt={fmt} />
      <DailyCharts stats={stats} fmt={fmt} />
      <div className="grid-2">
        <Card title={t('stats.channels.title')}>
          <ChannelsTable channels={stats.channels} fmt={fmt} />
        </Card>
        <Card title={t('stats.pages.title')}>
          <PagesTable pages={stats.pages} fmt={fmt} />
        </Card>
        <Card title={t('stats.tools.title')}>
          <ToolsTable tools={stats.tools} fmt={fmt} />
        </Card>
        <Card title={t('stats.clients.title')}>
          <ClientsTable clients={stats.clients} fmt={fmt} />
        </Card>
      </div>
      <ToolBreakdowns stats={stats} fmt={fmt} />
      <div className="grid-2">
        <HoursCard title={t('stats.hours.mcp')} values={stats.hours.mcp} fmt={fmt} />
        <HoursCard title={t('stats.hours.web')} values={stats.hours.web} fmt={fmt} />
      </div>
      <OperationsCards stats={stats} fmt={fmt} />
    </>
  );
}

function StatsView() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const days = parseStatsRange(params.get('days'));
  const stats = useAsync(getUsageStats, days);

  const onRange = (d: StatsRange) => {
    const next = new URLSearchParams(params);
    next.set('days', String(d));
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader
        title={t('stats.title')}
        desc={t('stats.desc')}
        actions={<RangePicker value={days} onChange={onRange} />}
      />
      <AsyncBlock state={stats}>{(data) => <StatsBody stats={data} />}</AsyncBlock>
    </>
  );
}

/** Operator-only usage page; everyone else gets the same fallback as an unknown route. */
export function StatsPage() {
  const { me } = useSession();
  if (!me.isAdmin) return <Navigate to="/" replace />;
  return <StatsView />;
}
