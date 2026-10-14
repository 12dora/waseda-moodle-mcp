/**
 * Local single-user entry: MCP over stdio, talking to Waseda Moodle with the user's own token.
 *
 *   waseda-moodle-mcp                      serve (reads WMM_TOKEN or ~/.config/waseda-moodle-mcp/token)
 *   waseda-moodle-mcp --read-only          same, without the write tools (or WMM_READ_ONLY=1)
 *   waseda-moodle-mcp connect "<link>"     store the token from a Moodle launch link
 *
 * stdout belongs to the protocol while serving: everything we say goes to stderr.
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { ServiceContext } from '../core/context';
import { b64urlEncode, createSigner, importMasterKey } from '../core/crypto';
import { InvalidInput, WmmError } from '../core/errors';
import { buildMcpServer, SERVER_VERSION } from '../core/mcp/server';
import { MoodleClient } from '../core/moodle/client';
import { launchUrl, MOODLE_URL, parseLaunch } from '../core/moodle/launch';
import type { Scope } from '../core/types';
import { MemoryStore } from './store-memory';

const CONFIG_DIR = process.env.WMM_CONFIG_DIR || join(homedir(), '.config', 'waseda-moodle-mcp');
const TOKEN_FILE = join(CONFIG_DIR, 'token');
const STATE_FILE = join(CONFIG_DIR, 'state.json');

const log = (msg: string) => console.error(`[waseda-moodle-mcp] ${msg}`);

const USAGE = `waseda-moodle-mcp ${SERVER_VERSION}

Usage:
  waseda-moodle-mcp [--read-only]    Run the MCP server on stdio.
  waseda-moodle-mcp connect "<link>" Save your Moodle token (mode 0600) in ${TOKEN_FILE}.

How to get the link:
  1. Open ${launchUrl('wmm')} in a browser where you are signed in to Waseda Moodle.
  2. Right-click the "Open in app" link on that page, choose "Copy link address".
  3. Run: waseda-moodle-mcp connect "<pasted link>"

Environment: WMM_TOKEN (token or link, overrides the file), WMM_READ_ONLY=1, WMM_CONFIG_DIR, HTTPS_PROXY.`;

// ------------------------------------------------------------------ plumbing

/** Plain fetch, or undici's fetch through EnvHttpProxyAgent when HTTPS_PROXY is set and undici is loadable. */
async function makeFetch(): Promise<typeof fetch | undefined> {
  if (!process.env.HTTPS_PROXY && !process.env.https_proxy) return undefined;
  try {
    const specifier = 'undici'; // not a literal: undici is optional and must not be bundled
    const mod = (await import(specifier)) as { EnvHttpProxyAgent: new () => unknown; fetch: typeof fetch };
    const dispatcher = new mod.EnvHttpProxyAgent();
    return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      mod.fetch(input, { ...init, dispatcher } as RequestInit)) as typeof fetch;
  } catch {
    log('HTTPS_PROXY is set but the "undici" package could not be loaded; connecting directly.');
    return undefined;
  }
}

async function readToken(): Promise<string> {
  const fromEnv = process.env.WMM_TOKEN?.trim();
  if (fromEnv) return parseLaunch(fromEnv).token;
  let raw: string;
  try {
    raw = await readFile(TOKEN_FILE, 'utf8');
  } catch {
    throw new InvalidInput(
      `No Moodle token found. Set WMM_TOKEN, or run: waseda-moodle-mcp connect "<link>" (see --help for how to get the link).`,
    );
  }
  return parseLaunch(raw).token;
}

interface Identity {
  userId: number;
  fullname: string;
  lang: string;
}

/** core_webservice_get_site_info: proves the token works and tells us whose it is. */
async function identify(token: string, fetchImpl: typeof fetch | undefined): Promise<Identity> {
  const client = new MoodleClient({ token, moodleUserId: 0, fetch: fetchImpl });
  const info = await client.call<{ siteurl?: unknown; userid?: unknown; fullname?: unknown; lang?: unknown }>(
    'core_webservice_get_site_info',
  );
  let siteOk = false;
  try {
    siteOk = typeof info.siteurl === 'string' && new URL(info.siteurl).origin === new URL(MOODLE_URL).origin;
  } catch {
    /* handled below */
  }
  if (!siteOk || typeof info.userid !== 'number' || info.userid <= 0) {
    throw new InvalidInput('That token does not belong to Waseda Moodle.');
  }
  return {
    userId: info.userid,
    fullname: typeof info.fullname === 'string' && info.fullname ? info.fullname : `User ${info.userid}`,
    lang: typeof info.lang === 'string' && info.lang ? info.lang : 'en',
  };
}

// ------------------------------------------------------------------ commands

async function connectCommand(args: string[]): Promise<void> {
  const input = args.join(' ').trim();
  if (!input) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const { token } = parseLaunch(input);
  const who = await identify(token, await makeFetch());
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  await chmod(TOKEN_FILE, 0o600);
  process.stdout.write(`Connected to Waseda Moodle as ${who.fullname}. Token saved to ${TOKEN_FILE}.\n`);
}

async function serveCommand(args: string[]): Promise<void> {
  const readOnly =
    args.includes('--read-only') || ['1', 'true'].includes((process.env.WMM_READ_ONLY ?? '').toLowerCase());
  const token = await readToken();
  const fetchImpl = await makeFetch();
  const who = await identify(token, fetchImpl);

  const store = new MemoryStore({
    persistPath: STATE_FILE,
    onPersistError: () => log(`Could not read or write ${STATE_FILE}; settings and pending actions are not persisted.`),
  });
  const user = await store.upsertUser({ moodleUserId: who.userId, fullname: who.fullname, lang: who.lang });
  const signer = createSigner(await importMasterKey(b64urlEncode(crypto.getRandomValues(new Uint8Array(32)))));

  // The Moodle client budgets calls per request and memoises reads; the server is long-lived, so hand out a
  // fresh client unless the previous one was used moments ago (nested service calls share memoised reads).
  let current: { client: MoodleClient; usedAt: number } | null = null;
  const moodle = async (): Promise<MoodleClient> => {
    const now = Date.now();
    if (!current || now - current.usedAt > 2000 || current.client.callsMade >= 30) {
      current = {
        client: new MoodleClient({
          token,
          moodleUserId: who.userId,
          fetch: fetchImpl,
          onTokenInvalid: async () =>
            log('The Moodle token is no longer valid. Run "waseda-moodle-mcp connect" and restart.'),
        }),
        usedAt: now,
      };
    }
    current.usedAt = now;
    return current.client;
  };

  const scopes: Scope[] = readOnly ? ['moodle:read'] : ['moodle:read', 'moodle:write'];
  const ctx: ServiceContext = {
    user,
    store,
    signer,
    moodle,
    publicUrl: '',
    mode: 'stdio',
    scopes,
    source: 'Local',
    defer: (p) => void p.catch(() => undefined),
  };

  const handle = serveStdio(() => buildMcpServer(ctx), {
    onerror: (e) => log(`transport error: ${e.message}`),
  });
  log(`serving ${who.fullname} (${readOnly ? 'read-only' : 'read + write'}).`);

  const stop = () => {
    void handle.close().finally(() => store.flush().finally(() => process.exit(0)));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (args[0] === '--version' || args[0] === '-v') {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }
  if (args[0] === 'connect') return connectCommand(args.slice(1));
  return serveCommand(args);
}

main().catch((e: unknown) => {
  log(e instanceof WmmError ? e.message : `Unexpected error (${e instanceof Error ? e.name : typeof e}).`);
  process.exit(1);
});
