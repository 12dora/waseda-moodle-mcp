import { describe, expect, it } from 'vitest';
import { en } from '../i18n/en';
import {
  claudeCodeCommand,
  clientGuides,
  codexCommands,
  cursorConfig,
  geminiCommands,
  geminiKeyConfig,
  grokCommand,
  vscodeConfig,
} from './clientSnippets';

const URL = 'https://wasemoodle.example.com/mcp';
// Literal `${…}` references the client resolves itself (escaped so they are not interpolated here).
const CURSOR_AUTH = `Bearer \${env:WMM_API_KEY}`;
const VSCODE_AUTH = `Bearer \${input:wmm-api-key}`;

describe('client snippets', () => {
  it('builds Claude Code commands for OAuth and API key', () => {
    expect(claudeCodeCommand(URL)).toBe(`claude mcp add --transport http waseda-moodle ${URL}`);
    const keyed = claudeCodeCommand(URL, true);
    expect(keyed).toContain(`waseda-moodle ${URL}`);
    expect(keyed).toContain('--header "Authorization: Bearer <API_KEY>"');
  });

  it('builds Cursor and VS Code configs as valid JSON', () => {
    expect(JSON.parse(cursorConfig(URL))).toEqual({ mcpServers: { 'waseda-moodle': { url: URL } } });
    expect(JSON.parse(vscodeConfig(URL))).toEqual({ servers: { 'waseda-moodle': { type: 'http', url: URL } } });
  });

  it('keeps API keys out of IDE config files', () => {
    expect(JSON.parse(cursorConfig(URL, true))).toEqual({
      mcpServers: { 'waseda-moodle': { url: URL, headers: { Authorization: CURSOR_AUTH } } },
    });
    const vscode = JSON.parse(vscodeConfig(URL, true));
    expect(vscode.inputs).toEqual([
      { type: 'promptString', id: 'wmm-api-key', description: 'Waseda Moodle MCP API key', password: true },
    ]);
    expect(vscode.servers['waseda-moodle']).toEqual({
      type: 'http',
      url: URL,
      headers: { Authorization: VSCODE_AUTH },
    });
    expect(cursorConfig(URL, true) + vscodeConfig(URL, true)).not.toContain('<API_KEY>');
  });

  it('builds CLI commands', () => {
    expect(codexCommands(URL)).toBe(`codex mcp add waseda-moodle --url ${URL}\ncodex mcp login waseda-moodle`);
    expect(codexCommands(URL, true)).toBe(
      `codex mcp add waseda-moodle --url ${URL} --bearer-token-env-var WMM_API_KEY`,
    );
    expect(geminiCommands(URL)).toContain(`gemini mcp add --transport http waseda-moodle ${URL}`);
    expect(grokCommand(URL)).toBe(`grok mcp add --transport http waseda-moodle ${URL}`);
    expect(grokCommand(URL, true)).toContain('--header "Authorization: Bearer <API_KEY>"');
  });

  it('uses httpUrl (Streamable HTTP) for Gemini CLI', () => {
    const cfg = JSON.parse(geminiKeyConfig(URL));
    expect(cfg.mcpServers['waseda-moodle']).toEqual({ httpUrl: URL, headers: { Authorization: 'Bearer <API_KEY>' } });
  });
});

describe('clientGuides', () => {
  const guides = clientGuides(URL);

  it('lists the vendor tabs in order', () => {
    expect(guides.map((g) => g.id)).toEqual(['claude', 'chatgpt', 'grok', 'code', 'ide', 'cli', 'other']);
  });

  it('keeps every guide short and translatable', () => {
    for (const g of guides) {
      expect(g.steps.length).toBeGreaterThanOrEqual(2);
      expect(g.steps.length).toBeLessThanOrEqual(4);
      const keys = [g.label, g.note, ...g.steps.map((s) => s.text), ...(g.keySteps ?? []).map((s) => s.text)];
      for (const k of keys) if (k) expect(en[k]).toBeTruthy();
    }
  });

  it('offers an API-key variant only for header-capable clients', () => {
    const withKey = guides.filter((g) => g.keySteps).map((g) => g.id);
    expect(withKey).toEqual(['code', 'ide', 'cli', 'other']);
  });

  it('builds every snippet from the live MCP URL', () => {
    const other = 'https://other.example.com/mcp';
    const codes = clientGuides(other).flatMap((g) => g.steps.map((s) => s.code).filter(Boolean));
    expect(codes.length).toBeGreaterThan(0);
    for (const c of codes) expect(c).toContain(other);
  });

  it('builds every API-key snippet from the live MCP URL (Other is the bare header)', () => {
    const other = 'https://other.example.com/mcp';
    for (const g of clientGuides(other)) {
      for (const s of g.keySteps ?? []) {
        if (g.id === 'other') expect(s.code).toBe('Authorization: Bearer <API_KEY>');
        else expect(s.code).toContain(other);
      }
    }
  });
});
