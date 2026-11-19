/** Settings tabs in display order; each id is also the URL segment (`/settings/<id>`). */
export const SETTINGS_TABS = [
  'general',
  'courses',
  'connect',
  'keys',
  'apps',
  'calendar',
  'mail',
  'activity',
  'account',
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** Tabs that exist only when the server offers the feature. */
const OPTIONAL_TABS: readonly SettingsTab[] = ['mail'];

/** Tabs shown for this server (`mailOffered` = `me.mail` is not null). */
export function visibleSettingsTabs(mailOffered: boolean): readonly SettingsTab[] {
  return SETTINGS_TABS.filter((id) => mailOffered || !OPTIONAL_TABS.includes(id));
}

/** Maps the `:tab` route param to a visible tab; missing, unknown or hidden ids fall back to `general`. */
export function resolveSettingsTab(
  param: string | undefined,
  visible: readonly SettingsTab[] = SETTINGS_TABS,
): SettingsTab {
  return visible.find((id) => id === param) ?? 'general';
}
