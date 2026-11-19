import { describe, expect, it } from 'vitest';
import { resolveSettingsTab, SETTINGS_TABS, visibleSettingsTabs } from './tabs';

describe('resolveSettingsTab', () => {
  it('returns known tab ids unchanged', () => {
    for (const id of SETTINGS_TABS) expect(resolveSettingsTab(id)).toBe(id);
  });

  it('falls back to general for missing or unknown ids', () => {
    expect(resolveSettingsTab(undefined)).toBe('general');
    expect(resolveSettingsTab('')).toBe('general');
    expect(resolveSettingsTab('nope')).toBe('general');
    expect(resolveSettingsTab('Keys')).toBe('general');
  });

  it('falls back to general for a tab the server does not offer', () => {
    expect(resolveSettingsTab('mail', visibleSettingsTabs(false))).toBe('general');
    expect(resolveSettingsTab('mail', visibleSettingsTabs(true))).toBe('mail');
  });
});

describe('visibleSettingsTabs', () => {
  it('shows the mail tab only when mail is offered, keeping the order', () => {
    expect(visibleSettingsTabs(true)).toEqual(SETTINGS_TABS);
    const hidden = visibleSettingsTabs(false);
    expect(hidden).not.toContain('mail');
    expect(hidden).toHaveLength(SETTINGS_TABS.length - 1);
  });
});
