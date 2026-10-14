import type { MessageKey, Translate } from '../i18n/core';

const ACTIONS: Readonly<Record<string, MessageKey>> = {
  connect: 'audit.action.connect',
  'action:prepare': 'audit.action.action_prepare',
  'action:execute': 'audit.action.action_execute',
  'action:cancel': 'audit.action.action_cancel',
  'action:expire': 'audit.action.action_expire',
  'apikey:create': 'audit.action.apikey_create',
  'apikey:revoke': 'audit.action.apikey_revoke',
  'app:revoke': 'audit.action.app_revoke',
  'file:link': 'audit.action.file_link',
  'upload:create': 'audit.action.upload_create',
  'upload:file': 'audit.action.upload_file',
  'settings:update': 'audit.action.settings_update',
};

const ACTORS: Readonly<Record<string, MessageKey>> = {
  console: 'audit.actor.console',
  extension: 'audit.actor.extension',
  system: 'audit.actor.system',
};

/** Localized audit action; unknown actions fall back to the raw identifier. */
export function auditActionLabel(action: string, t: Translate): string {
  if (action.startsWith('tool:')) return t('audit.action.tool', { name: action.slice(5) });
  const key = ACTIONS[action];
  return key ? t(key) : action;
}

/** "console" / "extension" / "system" are localized; "mcp:<source>" shows the client or API key name. */
export function auditActorLabel(actor: string, t: Translate): string {
  if (actor.startsWith('mcp:')) return actor.slice(4);
  const key = ACTORS[actor];
  return key ? t(key) : actor;
}
