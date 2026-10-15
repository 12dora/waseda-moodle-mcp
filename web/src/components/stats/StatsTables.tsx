import type { UsageStats } from '../../api/types';
import { type MessageKey, useI18n } from '../../i18n';
import { failureRate, formatRate, peakOf, sharePercent, shortDay } from '../../lib/stats';
import { EmptyState } from '../EmptyState';

type Fmt = (n: number) => string;

/** Server client labels that have a translation; every other label is a product name. */
const CLIENT_KEYS: Readonly<Record<string, MessageKey>> = {
  'API key': 'stats.client.apiKey',
  Other: 'stats.client.other',
};

function Meter({ value, max, fmt }: { value: number; max: number; fmt: Fmt }) {
  return (
    <div className="stat-meter">
      <span className="stat-num">{fmt(value)}</span>
      <span className="stat-meter-track" aria-hidden="true">
        <span className="stat-meter-fill" style={{ width: `${sharePercent(value, max)}%` }} />
      </span>
    </div>
  );
}

export function ToolsTable({ tools, fmt }: { tools: UsageStats['tools']; fmt: Fmt }) {
  const { t, lang } = useI18n();
  if (tools.length === 0) return <EmptyState>{t('stats.tools.empty')}</EmptyState>;
  const max = peakOf(tools.map((r) => r.calls));
  return (
    <div className="table-wrap">
      <table className="table stat-table">
        <thead>
          <tr>
            <th scope="col">{t('stats.col.tool')}</th>
            <th scope="col">{t('stats.col.calls')}</th>
            <th scope="col" className="num">
              {t('stats.col.failed')}
            </th>
            <th scope="col" className="num">
              {t('stats.col.rate')}
            </th>
          </tr>
        </thead>
        <tbody>
          {tools.map((r) => (
            <tr key={r.name}>
              <td className="mono">{r.name}</td>
              <td>
                <Meter value={r.calls} max={max} fmt={fmt} />
              </td>
              <td className="num">{fmt(r.errors)}</td>
              <td className="num">{formatRate(failureRate(r.calls, r.errors), lang)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ClientsTable({ clients, fmt }: { clients: UsageStats['clients']; fmt: Fmt }) {
  const { t } = useI18n();
  if (clients.length === 0) return <EmptyState>{t('stats.clients.empty')}</EmptyState>;
  const max = peakOf(clients.map((r) => r.calls));
  return (
    <div className="table-wrap">
      <table className="table stat-table">
        <thead>
          <tr>
            <th scope="col">{t('stats.col.client')}</th>
            <th scope="col">{t('stats.col.calls')}</th>
            <th scope="col" className="num">
              {t('stats.col.activeMonth')}
            </th>
          </tr>
        </thead>
        <tbody>
          {clients.map((r) => {
            const key = CLIENT_KEYS[r.name];
            return (
              <tr key={r.name}>
                <td className="nowrap">{key ? t(key) : r.name}</td>
                <td>
                  <Meter value={r.calls} max={max} fmt={fmt} />
                </td>
                <td className="num">{fmt(r.activeMonth)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Data-table alternative to both daily charts, newest day first. */
export function DailyTable({ daily, fmt }: { daily: UsageStats['daily']; fmt: Fmt }) {
  const { t } = useI18n();
  return (
    <div className="table-wrap">
      <table className="table stat-table">
        <thead>
          <tr>
            <th scope="col">{t('stats.col.day')}</th>
            <th scope="col" className="num">
              {t('stats.col.active')}
            </th>
            <th scope="col" className="num">
              {t('stats.col.calls')}
            </th>
            <th scope="col" className="num">
              {t('stats.col.failed')}
            </th>
            <th scope="col" className="num">
              {t('stats.col.newUsers')}
            </th>
          </tr>
        </thead>
        <tbody>
          {[...daily].reverse().map((d) => (
            <tr key={d.day}>
              <td className="num-day">
                <time dateTime={d.day}>{shortDay(d.day)}</time>
              </td>
              <td className="num">{fmt(d.active)}</td>
              <td className="num">{fmt(d.calls)}</td>
              <td className="num">{fmt(d.errors)}</td>
              <td className="num">{fmt(d.newUsers)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
