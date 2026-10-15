import { describe, expect, it } from 'vitest';
import {
  CLIENT_API_KEY,
  CLIENT_OTHER,
  clientLabel,
  jstDay,
  jstMonth,
  jstWeekStart,
  usagePeriods,
} from '../../src/core/usage';

const utc = (iso: string) => Date.parse(iso);

describe('JST periods', () => {
  it('rolls the day at 15:00 UTC', () => {
    expect(jstDay(utc('2026-10-15T14:59:59Z'))).toBe('2026-10-15');
    expect(jstDay(utc('2026-10-15T15:00:00Z'))).toBe('2026-10-16');
    expect(jstDay(utc('2026-12-31T15:00:00Z'))).toBe('2027-01-01');
  });

  it('rolls the month at the JST month boundary', () => {
    expect(jstMonth(utc('2026-10-31T14:59:59Z'))).toBe('2026-10');
    expect(jstMonth(utc('2026-10-31T15:00:00Z'))).toBe('2026-11');
  });

  it('starts the week on Monday (JST)', () => {
    expect(jstWeekStart(utc('2026-10-11T15:00:00Z'))).toBe('2026-10-12'); // Monday 00:00 JST
    expect(jstWeekStart(utc('2026-10-11T14:59:59Z'))).toBe('2026-10-05'); // Sunday 23:59 JST
    expect(jstWeekStart(utc('2026-10-15T03:00:00Z'))).toBe('2026-10-12'); // Thursday
    expect(jstWeekStart(utc('2026-10-18T14:59:59Z'))).toBe('2026-10-12'); // Sunday evening
  });

  it('finds the Monday across month and year boundaries', () => {
    expect(jstWeekStart(utc('2026-11-01T03:00:00Z'))).toBe('2026-10-26'); // Sunday 1 Nov
    expect(jstWeekStart(utc('2027-01-01T03:00:00Z'))).toBe('2026-12-28'); // Friday 1 Jan
    expect(jstWeekStart(utc('2024-03-01T03:00:00Z'))).toBe('2024-02-26'); // leap year
  });

  it('prefixes the period keys', () => {
    expect(usagePeriods(utc('2026-10-15T03:00:00Z'))).toEqual({
      day: 'd:2026-10-15',
      week: 'w:2026-10-12',
      month: 'm:2026-10',
    });
  });
});

describe('clientLabel', () => {
  const cases: [string, string][] = [
    ['API key: my laptop', CLIENT_API_KEY],
    ['api key: x', CLIENT_API_KEY],
    ['Claude Code', 'Claude Code'],
    ['Claude', 'Claude'],
    ['Claude Desktop', 'Claude'],
    ['ChatGPT', 'ChatGPT'],
    ['OpenAI MCP', 'ChatGPT'],
    ['Cursor', 'Cursor'],
    ['Visual Studio Code', 'VS Code'],
    ['VS Code', 'VS Code'],
    ['vscode-mcp', 'VS Code'],
    ['Codex CLI', 'Codex'],
    ['Grok', 'Grok'],
    ['xAI Console', 'Grok'],
    ['Gemini CLI', 'Gemini'],
    ['Windsurf', 'Windsurf'],
    ['LobeHub', 'LobeHub'],
    ['LobeChat', 'LobeHub'],
    ['Cherry Studio', 'Cherry Studio'],
    ['Goose', 'Goose'],
    ['MCP Inspector', 'MCP Inspector'],
    ['MCP client', CLIENT_OTHER],
    ['', CLIENT_OTHER],
    ['Totally Unknown <script>', CLIENT_OTHER],
  ];
  it.each(cases)('%j -> %s', (source, label) => {
    expect(clientLabel(source)).toBe(label);
  });

  it('prefers the more specific rule and the API-key prefix', () => {
    expect(clientLabel('Claude Code via Cursor')).toBe('Claude Code');
    expect(clientLabel('API key: Claude Code')).toBe(CLIENT_API_KEY);
    expect(clientLabel('my API key: Cursor')).toBe('Cursor'); // "API key:" only counts as a prefix
  });
});
