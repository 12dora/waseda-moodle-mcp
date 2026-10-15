/** Settings tabs in display order; each id is also the URL segment (`/settings/<id>`). */
export const SETTINGS_TABS = [
  'general',
  'courses',
  'connect',
  'keys',
  'apps',
  'calendar',
  'activity',
  'account',
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** Maps the `:tab` route param to a tab; missing or unknown ids fall back to `general`. */
export function resolveSettingsTab(param: string | undefined): SettingsTab {
  return SETTINGS_TABS.find((id) => id === param) ?? 'general';
}
