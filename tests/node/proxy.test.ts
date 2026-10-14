import { describe, expect, it } from 'vitest';
import { makeProxyFetch, proxyFromEnv } from '../../src/node/proxy';

describe('proxyFromEnv', () => {
  it('is undefined without proxy variables', () => {
    expect(proxyFromEnv({})).toBeUndefined();
    expect(makeProxyFetch({})).toBeUndefined();
  });

  it('prefers HTTPS_PROXY, then https_proxy, then ALL_PROXY, and passes NO_PROXY', () => {
    expect(proxyFromEnv({ HTTPS_PROXY: 'http://p1:1', https_proxy: 'http://p2:2', ALL_PROXY: 'http://p3:3' })).toEqual({
      httpsProxy: 'http://p1:1',
    });
    expect(proxyFromEnv({ https_proxy: 'http://p2:2' })).toEqual({ httpsProxy: 'http://p2:2' });
    expect(proxyFromEnv({ all_proxy: 'http://p3:3', no_proxy: 'localhost' })).toEqual({
      httpsProxy: 'http://p3:3',
      noProxy: 'localhost',
    });
  });

  it('builds a fetch when a proxy is configured', () => {
    expect(typeof makeProxyFetch({ HTTPS_PROXY: 'http://127.0.0.1:9' })).toBe('function');
  });
});
