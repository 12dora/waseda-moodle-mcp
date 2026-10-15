import { type KeyboardEvent, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useT } from '../i18n';
import { type ClientGuide, type ClientId, type ClientStep, clientGuides } from '../lib/clientSnippets';
import { useConfig } from '../session';
import { Card } from './Card';
import { CopyField } from './CopyField';

const tabId = (id: ClientId) => `client-tab-${id}`;
const panelId = (id: ClientId) => `client-panel-${id}`;

function Steps({ steps }: { steps: ClientStep[] }) {
  const t = useT();
  return (
    <ol className="steps client-steps">
      {steps.map((s) => (
        <li key={`${s.text}-${s.code ?? ''}`}>
          {s.code ? <CopyField label={t(s.text)} value={s.code} multiline /> : t(s.text)}
        </li>
      ))}
    </ol>
  );
}

function ClientPanel({ guide, active }: { guide: ClientGuide; active: boolean }) {
  const t = useT();
  return (
    <div
      role="tabpanel"
      id={panelId(guide.id)}
      aria-labelledby={tabId(guide.id)}
      hidden={!active}
      className="tab-panel"
    >
      <Steps steps={guide.steps} />
      {guide.keySteps && (
        <details className="disclosure">
          <summary>{t('client.key.summary')}</summary>
          <Steps steps={guide.keySteps} />
          <Link className="btn btn-secondary btn-sm" to="/keys">
            {t('client.key.create')}
          </Link>
        </details>
      )}
      {guide.note && <p className="muted small">{t(guide.note)}</p>}
    </div>
  );
}

/** Arrow / Home / End move between tabs (WAI-ARIA tabs pattern, automatic activation). */
const KEY_MOVES: Record<string, (i: number, n: number) => number> = {
  ArrowRight: (i, n) => (i + 1) % n,
  ArrowLeft: (i, n) => (i - 1 + n) % n,
  Home: () => 0,
  End: (_i, n) => n - 1,
};

function ClientTabs({
  guides,
  tab,
  onSelect,
}: {
  guides: ClientGuide[];
  tab: ClientId;
  onSelect: (id: ClientId) => void;
}) {
  const t = useT();
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const moveFn = KEY_MOVES[e.key];
    if (!moveFn) return;
    e.preventDefault();
    const next =
      guides[
        moveFn(
          guides.findIndex((g) => g.id === tab),
          guides.length,
        )
      ];
    if (!next) return;
    onSelect(next.id);
    document.getElementById(tabId(next.id))?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label={t('client.title')}>
      {guides.map((g) => (
        <button
          key={g.id}
          type="button"
          role="tab"
          id={tabId(g.id)}
          aria-selected={tab === g.id}
          aria-controls={panelId(g.id)}
          tabIndex={tab === g.id ? 0 : -1}
          className={`tab${tab === g.id ? ' active' : ''}`}
          onClick={() => onSelect(g.id)}
          onKeyDown={onKeyDown}
        >
          {t(g.label)}
        </button>
      ))}
    </div>
  );
}

/** "Connect an AI client": MCP URL plus per-vendor setup (OAuth first, API key where headers are supported). */
export function ClientCard() {
  const t = useT();
  const { mcpUrl } = useConfig();
  const guides = useMemo(() => clientGuides(mcpUrl), [mcpUrl]);
  const [tab, setTab] = useState<ClientId>('claude');
  return (
    <Card title={t('client.title')}>
      <CopyField label={t('client.mcpUrl')} value={mcpUrl} />
      <ClientTabs guides={guides} tab={tab} onSelect={setTab} />
      {guides.map((g) => (
        <ClientPanel key={g.id} guide={g} active={tab === g.id} />
      ))}
    </Card>
  );
}
