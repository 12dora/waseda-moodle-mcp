import type { UsageStats } from '../../api/types';
import { type MessageKey, useI18n } from '../../i18n';
import { FAILURE_CLASSES, formatRetained, LATENCY_BUCKETS, weekRange, withCounts } from '../../lib/stats';
import { StatTable } from './StatTable';

type Fmt = (n: number) => string;
type Tools = UsageStats['tools'];

/** Label for a server-side vocabulary value (`prefix.value`); unknown values show as sent. */
function useVocabulary(prefix: string): (value: string) => string {
  const { t } = useI18n();
  return (value) => {
    const key = `${prefix}.${value}` as MessageKey;
    const label = t(key);
    return label === key ? value : label;
  };
}

export function ChannelsTable({ channels, fmt }: { channels: UsageStats['channels']; fmt: Fmt }) {
  const { t } = useI18n();
  const periods = ['today', 'week', 'month'] as const;
  return (
    <StatTable
      head={[t('stats.col.period'), t('stats.channel.mcp'), t('stats.channel.web'), t('stats.channel.total')]}
      rows={periods.map((p) => ({
        key: p,
        label: t(`stats.period.${p}`),
        cells: [fmt(channels[p].mcp), fmt(channels[p].web), fmt(channels[p].total)],
      }))}
      empty=""
    />
  );
}

export function PagesTable({ pages, fmt }: { pages: UsageStats['pages']; fmt: Fmt }) {
  const { t } = useI18n();
  const label = useVocabulary('stats.page');
  return (
    <StatTable
      head={[t('stats.col.page'), t('stats.col.requests')]}
      rows={pages.map((p) => ({ key: p.name, label: label(p.name), cells: [fmt(p.requests)] }))}
      empty={t('stats.pages.empty')}
    />
  );
}

/** Per-tool counts split by a fixed vocabulary (failure classes, response-time buckets). */
function ToolBreakdown<K extends string>({
  tools,
  keys,
  pick,
  prefix,
  empty,
  fmt,
}: {
  tools: Tools;
  keys: readonly K[];
  pick: (tool: Tools[number]) => Record<K, number>;
  prefix: string;
  empty: string;
  fmt: Fmt;
}) {
  const { t } = useI18n();
  const label = useVocabulary(prefix);
  return (
    <StatTable
      mono
      head={[t('stats.col.tool'), ...keys.map(label)]}
      rows={withCounts(tools, pick).map((tool) => ({
        key: tool.name,
        label: tool.name,
        cells: keys.map((k) => fmt(pick(tool)[k])),
      }))}
      empty={empty}
    />
  );
}

export function FailuresTable({ tools, fmt }: { tools: Tools; fmt: Fmt }) {
  const { t } = useI18n();
  return (
    <ToolBreakdown
      tools={tools}
      keys={FAILURE_CLASSES}
      pick={(tool) => tool.failures}
      prefix="stats.failure"
      empty={t('stats.failures.empty')}
      fmt={fmt}
    />
  );
}

export function LatencyTable({ tools, fmt }: { tools: Tools; fmt: Fmt }) {
  const { t } = useI18n();
  return (
    <ToolBreakdown
      tools={tools}
      keys={LATENCY_BUCKETS}
      pick={(tool) => tool.latency}
      prefix="stats.latency"
      empty={t('stats.tools.empty')}
      fmt={fmt}
    />
  );
}

/** Write funnel per action kind: prepared → completed / failed / cancelled / expired. */
export function ActionsTable({ actions, fmt }: { actions: UsageStats['actions']; fmt: Fmt }) {
  const { t } = useI18n();
  const rows = actions.filter((a) => a.prepared || a.executed || a.failed || a.cancelled || a.expired);
  return (
    <StatTable
      head={[
        t('stats.col.kind'),
        t('stats.col.prepared'),
        t('actions.status.executed'),
        t('actions.status.failed'),
        t('actions.status.cancelled'),
        t('actions.status.expired'),
      ]}
      rows={rows.map((a) => ({
        key: a.kind,
        label: t(`actions.kind.${a.kind}`),
        cells: [a.prepared, a.executed, a.failed, a.cancelled, a.expired].map(fmt),
      }))}
      empty={t('stats.actions.empty')}
    />
  );
}

/** Current connection state plus renewal totals for the range. */
export function CredentialsTable({ stats, fmt }: { stats: UsageStats; fmt: Fmt }) {
  const { t } = useI18n();
  const c = stats.credentials;
  const days = { days: stats.days };
  const rows: Array<[string, string, number]> = [
    ['active', t('stats.cred.active'), c.active],
    ['invalid', t('stats.cred.invalid'), c.invalid],
    ['autoRenew', t('stats.cred.autoRenew'), c.autoRenew],
    ['renewed', t('stats.cred.renewed', days), c.renewed],
    ['kept', t('stats.cred.kept', days), c.kept],
    ['failed', t('stats.cred.failed', days), c.failed],
  ];
  return (
    <StatTable
      head={[t('stats.credentials.title'), t('stats.col.count')]}
      rows={rows.map(([key, label, n]) => ({ key, label, cells: [fmt(n)] }))}
      empty=""
    />
  );
}

export function RenewalFailuresTable({ failures, fmt }: { failures: UsageStats['credentials']['failures']; fmt: Fmt }) {
  const { t } = useI18n();
  return (
    <StatTable
      head={[t('stats.col.reason'), t('stats.col.count')]}
      rows={failures.map((f) => ({ key: f.reason, label: f.reason, cells: [fmt(f.count)] }))}
      empty={t('stats.renewFailures.empty')}
    />
  );
}

export function ConnectsTable({ connects, fmt }: { connects: UsageStats['credentials']['connects']; fmt: Fmt }) {
  const { t } = useI18n();
  const label = useVocabulary('stats.via');
  return (
    <StatTable
      head={[t('stats.col.method'), t('stats.col.count')]}
      rows={connects.map((c) => ({ key: c.via, label: label(c.via), cells: [fmt(c.count)] }))}
      empty={t('stats.connects.empty')}
    />
  );
}

/** Signup-week groups (at least 3 signups each), oldest first. */
export function RetentionTable({ retention, fmt }: { retention: UsageStats['retention']; fmt: Fmt }) {
  const { t, lang } = useI18n();
  return (
    <StatTable
      head={[t('stats.col.week'), t('stats.col.cohort'), t('stats.col.w1'), t('stats.col.w2'), t('stats.col.w4')]}
      rows={retention.map((r) => ({
        key: r.from,
        label: weekRange(r.from, r.to),
        cells: [fmt(r.users), ...[r.w1, r.w2, r.w4].map((n) => formatRetained(n, r.users, lang))],
      }))}
      empty={t('stats.retention.empty')}
    />
  );
}
