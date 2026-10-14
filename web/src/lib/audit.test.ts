import { describe, expect, it } from 'vitest';
import { type Translate, translate } from '../i18n/core';
import { en } from '../i18n/en';
import { auditActionLabel, auditActorLabel } from './audit';

const t: Translate = (key, vars) => translate(en, key, vars);

describe('audit labels', () => {
  it('localizes known actions and tool calls', () => {
    expect(auditActionLabel('apikey:create', t)).toBe('Created API key');
    expect(auditActionLabel('tool:get_due_items', t)).toBe('Tool call: get_due_items');
    expect(auditActionLabel('something:new', t)).toBe('something:new');
  });

  it('localizes actors and shows MCP sources as is', () => {
    expect(auditActorLabel('console', t)).toBe('Console');
    expect(auditActorLabel('mcp:API key: laptop', t)).toBe('API key: laptop');
    expect(auditActorLabel('other', t)).toBe('other');
  });
});
