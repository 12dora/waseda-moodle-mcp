import { afterEach, describe, expect, it, vi } from 'vitest';
import { logPath, logRequest } from '../../src/worker/request-log';

describe('request log', () => {
  afterEach(() => vi.restoreAllMocks());

  it('drops queries and signed tickets from the path', () => {
    expect(logPath('https://s.example.com/api/due?refresh=1')).toBe('/api/due');
    expect(logPath('https://s.example.com/f/eyJrIjoiZGwi.sig')).toBe('/f/…');
    expect(logPath('https://s.example.com/u/eyJrIjoidXAi.sig?name=a.pdf')).toBe('/u/…');
    expect(logPath('https://s.example.com/f/')).toBe('/f/');
    expect(logPath('not a url')).toBe('?');
  });

  it('writes one structured line', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    logRequest(new Request('https://s.example.com/mcp?x=1', { method: 'POST' }), 200, 42);
    expect(log).toHaveBeenCalledWith({ kind: 'request', method: 'POST', path: '/mcp', status: 200, ms: 42 });
  });
});
