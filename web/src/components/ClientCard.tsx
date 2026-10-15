import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useT } from '../i18n';
import { type ClientGuide, type ClientId, type ClientStep, clientGuides } from '../lib/clientSnippets';
import { useConfig } from '../session';
import { Card } from './Card';
import { CopyField } from './CopyField';
import { TabPanel, Tabs } from './Tabs';

const ID_PREFIX = 'client';

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
    <TabPanel idPrefix={ID_PREFIX} id={guide.id} active={active}>
      <Steps steps={guide.steps} />
      {guide.keySteps && (
        <details className="disclosure">
          <summary>{t('client.key.summary')}</summary>
          <Steps steps={guide.keySteps} />
          <Link className="btn btn-secondary btn-sm" to="/settings/keys">
            {t('client.key.create')}
          </Link>
        </details>
      )}
      {guide.note && <p className="muted small">{t(guide.note)}</p>}
    </TabPanel>
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
      <Tabs
        idPrefix={ID_PREFIX}
        label={t('client.title')}
        items={guides.map((g) => ({ id: g.id, label: t(g.label) }))}
        value={tab}
        onChange={setTab}
      />
      {guides.map((g) => (
        <ClientPanel key={g.id} guide={g} active={tab === g.id} />
      ))}
    </Card>
  );
}
