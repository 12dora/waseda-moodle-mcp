import type { ComponentType } from 'react';
import { useNavigate, useParams } from 'react-router';
import { CalendarCard } from '../../components/CalendarCard';
import { ClientCard } from '../../components/ClientCard';
import { PageHeader } from '../../components/Layout';
import { TabPanel, Tabs } from '../../components/Tabs';
import { useT } from '../../i18n';
import { AccountTab } from './Account';
import { ActivityTab } from './Activity';
import { AppsTab } from './Apps';
import { CourseSelectionTab } from './CourseSelection';
import { GeneralTab } from './General';
import { KeysTab } from './Keys';
import { resolveSettingsTab, SETTINGS_TABS, type SettingsTab } from './tabs';

const ID_PREFIX = 'settings';

const PANELS: Record<SettingsTab, ComponentType> = {
  general: GeneralTab,
  courses: CourseSelectionTab,
  connect: ClientCard,
  keys: KeysTab,
  apps: AppsTab,
  calendar: CalendarCard,
  activity: ActivityTab,
  account: AccountTab,
};

/** Settings: one URL-addressable tab per area (`/settings/<tab>`); only the active panel is mounted. */
export function SettingsPage() {
  const t = useT();
  const navigate = useNavigate();
  const active = resolveSettingsTab(useParams().tab);
  const Panel = PANELS[active];
  return (
    <>
      <PageHeader title={t('settings.title')} />
      <Tabs
        idPrefix={ID_PREFIX}
        label={t('settings.title')}
        items={SETTINGS_TABS.map((id) => ({ id, label: t(`settings.tab.${id}`) }))}
        value={active}
        onChange={(id, { via }) => navigate(`/settings/${id}`, { replace: via === 'keyboard' })}
      />
      {SETTINGS_TABS.map((id) => (
        <TabPanel key={id} idPrefix={ID_PREFIX} id={id} active={id === active} className="settings-panel">
          {id === active && <Panel />}
        </TabPanel>
      ))}
    </>
  );
}
