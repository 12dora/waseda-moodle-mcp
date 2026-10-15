import { describe, expect, it } from 'vitest';
import { resolveSettingsTab, SETTINGS_TABS } from './tabs';

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
});
