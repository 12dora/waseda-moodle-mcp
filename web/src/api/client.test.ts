import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCourses, getTimetable, listActions } from './endpoints';

function stubFetch() {
  const fetchMock = vi.fn(async () => new Response('[]', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sentHeaders(fetchMock: ReturnType<typeof stubFetch>): Record<string, string> {
  const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
  return (calls[0]?.[1].headers ?? {}) as Record<string, string>;
}

afterEach(() => vi.unstubAllGlobals());

describe('background requests', () => {
  it('marks automatic refreshes', async () => {
    const fetchMock = stubFetch();
    await listActions('pending', 20, true);
    expect(sentHeaders(fetchMock)['X-WMM-Background']).toBe('1');
  });

  it('leaves user-initiated requests unmarked', async () => {
    const fetchMock = stubFetch();
    await listActions('pending', 20);
    expect(sentHeaders(fetchMock)).not.toHaveProperty('X-WMM-Background');
  });
});

describe('cached console reads', () => {
  const sentUrl = (fetchMock: ReturnType<typeof stubFetch>) =>
    (fetchMock.mock.calls as unknown as [string, RequestInit][])[0]?.[0] ?? '';

  it('ask for the stored copy as a user request', async () => {
    const fetchMock = stubFetch();
    await getTimetable('2026-11-30', 7);
    expect(sentUrl(fetchMock)).not.toContain('refresh');
    expect(sentHeaders(fetchMock)).not.toHaveProperty('X-WMM-Background');
  });

  it('refresh in the background with refresh=1', async () => {
    const fetchMock = stubFetch();
    await getCourses(true);
    expect(sentUrl(fetchMock)).toContain('refresh=1');
    expect(sentHeaders(fetchMock)['X-WMM-Background']).toBe('1');
  });
});
