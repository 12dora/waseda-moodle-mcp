/** HTTPS proxy support for the local entry: undici's fetch through EnvHttpProxyAgent (honours NO_PROXY). */

import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';

export interface ProxySettings {
  httpsProxy: string;
  noProxy?: string;
}

type Env = Record<string, string | undefined>;

/** HTTPS_PROXY / https_proxy, falling back to ALL_PROXY / all_proxy; undefined = connect directly. */
export function proxyFromEnv(env: Env = process.env): ProxySettings | undefined {
  const httpsProxy = env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy;
  if (!httpsProxy) return undefined;
  const noProxy = env.NO_PROXY || env.no_proxy;
  return noProxy ? { httpsProxy, noProxy } : { httpsProxy };
}

/** A fetch that goes through the proxy named in the environment, or undefined when none is configured. */
export function makeProxyFetch(env: Env = process.env): typeof fetch | undefined {
  const settings = proxyFromEnv(env);
  if (!settings) return undefined;
  const dispatcher = new EnvHttpProxyAgent(settings);
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    })) as unknown as typeof fetch;
}
