import type { ComponentType } from 'react';
import { useNavigate, useParams } from 'react-router';
import { CalendarCard } from '../../components/CalendarCard';
import { ClientCard } from '../../components/ClientCard';
import { PageHeader } from '../../components/Layout';
import { TabPanel, Tabs } from '../../components/Tabs';
import { useT } from '../../i18n';
import { useSession } from '../../session';
import { AccountTab } from './Account';
import { ActivityTab } from './Activity';
import { AppsTab } from './Apps';
import { CourseSelectionTab } from './CourseSelection';
import { GeneralTab } from './General';
import { KeysTab } from './Keys';
import { MailTab } from './Mail';
import { resolveSettingsTab, type SettingsTab, visibleSettingsTabs } from './tabs';

const ID_PREFIX = 'settings';

const PANELS: Record<SettingsTab, ComponentType> = {
  general: GeneralTab,
  courses: CourseSelectionTab,
  connect: ClientCard,
  keys: KeysTab,
  apps: AppsTab,
  calendar: CalendarCard,
  mail: MailTab,
  activity: ActivityTab,
  account: AccountTab,
};

/** Settings: one URL-addressable tab per area (`/settings/<tab>`); only the active panel is mounted. */
export function SettingsPage() {
  const t = useT();
  const navigate = useNavigate();
  const tabs = visibleSettingsTabs(Boolean(useSession().me.mail));
  const active = resolveSettingsTab(useParams().tab, tabs);
  const Panel = PANELS[active];
  return (
    <>
      <PageHeader title={t('settings.title')} />
      <Tabs
        idPrefix={ID_PREFIX}
        label={t('settings.title')}
        items={tabs.map((id) => ({ id, label: t(`settings.tab.${id}`) }))}
        value={active}
        onChange={(id, { via }) => navigate(`/settings/${id}`, { replace: via === 'keyboard' })}
      />
      {tabs.map((id) => (
        <TabPanel key={id} idPrefix={ID_PREFIX} id={id} active={id === active} className="settings-panel">
          {id === active && <Panel />}
        </TabPanel>
      ))}
    </>
  );
}
