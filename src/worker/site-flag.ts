/**
 * The site flag "Moodle's mobile web service is on" (the app token channel works). The cron checks it against Moodle
 * and a request that finds the service off clears it; requests read it through a per-isolate cache.
 */

import type { SiteMethods } from './store/site';

const KEY = 'mobile_service';
/** How long an isolate trusts the value it read. */
const CACHE_MS = 5 * 60_000;

let cached: { on: boolean; at: number } | null = null;

/** The stored value, read now (the cron compares it with what Moodle says). */
export async function readMobileService(store: SiteMethods, now = Date.now()): Promise<boolean> {
  const on = (await store.getSiteState(KEY)) === '1';
  cached = { on, at: now };
  return on;
}

/** The value for a request: at most one read per isolate every CACHE_MS. */
export async function mobileServiceOn(store: SiteMethods, now = Date.now()): Promise<boolean> {
  if (cached && now - cached.at < CACHE_MS) return cached.on;
  return readMobileService(store, now);
}

export async function setMobileService(store: SiteMethods, on: boolean, now = Date.now()): Promise<void> {
  cached = { on, at: now };
  await store.putSiteState(KEY, on ? '1' : '0', now);
}

/** Tests: forget the cached value (each test has its own database). */
export function resetSiteFlagMemory(): void {
  cached = null;
}
