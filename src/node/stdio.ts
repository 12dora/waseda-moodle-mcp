/**
 * Local single-user entry: MCP over stdio, talking to Waseda Moodle with the user's own token.
 *
 *   waseda-moodle-mcp                      serve (reads WMM_TOKEN or ~/.config/waseda-moodle-mcp/token)
 *   waseda-moodle-mcp --read-only          same, without the write tools (or WMM_READ_ONLY=1)
 *   waseda-moodle-mcp connect ["<link>"]   store the token from a Moodle launch link (argument or stdin)
 *
 * stdout belongs to the protocol while serving: everything we say goes to stderr.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { ServiceContext } from '../core/context';
import { b64urlEncode, createSigner, importMasterKey } from '../core/crypto';
import { InvalidInput, NeedsReconnect, WmmError } from '../core/errors';
import { buildMcpServer, SERVER_VERSION } from '../core/mcp/server';
import { RECONNECT_STDIO } from '../core/mcp/wording';
import { MoodleClient } from '../core/moodle/client';
import { launchUrl, MOODLE_URL, parseLaunch } from '../core/moodle/launch';
import type { Scope } from '../core/types';
import { type Command, parseArgs } from './args';
import { createMoodleProvider } from './moodle-session';
import { makeProxyFetch } from './proxy';
import { MemoryStore } from './store-memory';
import { readStdin, readToken, writeToken } from './token-file';

const CONFIG_DIR = process.env.WMM_CONFIG_DIR || join(homedir(), '.config', 'waseda-moodle-mcp');
const TOKEN_FILE = join(CONFIG_DIR, 'token');
const STATE_FILE = join(CONFIG_DIR, 'state.json');

const log = (msg: string) => console.error(`[waseda-moodle-mcp] ${msg}`);

const USAGE = `waseda-moodle-mcp ${SERVER_VERSION}

Usage:
  waseda-moodle-mcp [--read-only]     Run the MCP server on stdio.
  waseda-moodle-mcp connect ["<link>"] Save your Moodle token (mode 0600) in ${TOKEN_FILE}.
                                      Without an argument (or with "-") the link is read from stdin.

How to get the link:
  1. Open ${launchUrl('wmm')} in a browser where you are signed in to Waseda Moodle.
  2. Right-click the "Open in app" link on that page, choose "Copy link address".
  3. Run: waseda-moodle-mcp connect "<pasted link>"

Environment: WMM_TOKEN (token or link, overrides the file), WMM_READ_ONLY=1, WMM_CONFIG_DIR,
HTTPS_PROXY / ALL_PROXY / NO_PROXY.`;

const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

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

async function connectCommand(input: string | null): Promise<void> {
  const link = input ?? (await readStdin());
  if (!link) throw new InvalidInput('No launch link given. Pass it as an argument or pipe it in (see --help).');
  const { token } = parseLaunch(link);
  const who = await identify(token, makeProxyFetch()).catch((e: unknown) => {
    if (e instanceof NeedsReconnect)
      throw new InvalidInput('Moodle rejected that token. Get a fresh link (see --help).');
    throw e;
  });
  await writeToken(TOKEN_FILE, token);
  out(`Connected to Waseda Moodle as ${who.fullname}. Token saved to ${TOKEN_FILE}.`);
}

async function serveCommand(readOnly: boolean): Promise<void> {
  const token = await readToken(TOKEN_FILE);
  const fetchImpl = makeProxyFetch();
  const who = await identify(token, fetchImpl);

  const store = new MemoryStore({
    persistPath: STATE_FILE,
    onPersistError: () => log(`Could not read or write ${STATE_FILE}; settings and pending actions are not persisted.`),
  });
  const user = await store.upsertUser({ moodleUserId: who.userId, fullname: who.fullname, lang: who.lang });
  const signer = createSigner(await importMasterKey(b64urlEncode(crypto.getRandomValues(new Uint8Array(32)))));
  const scopes: Scope[] = readOnly ? ['moodle:read'] : ['moodle:read', 'moodle:write'];
  const ctx: ServiceContext = {
    user,
    store,
    signer,
    moodle: createMoodleProvider({
      token,
      moodleUserId: who.userId,
      fetch: fetchImpl,
      onTokenInvalid: async () => log(RECONNECT_STDIO),
    }),
    publicUrl: '',
    mode: 'stdio',
    scopes,
    source: 'Local',
    defer: (p) => void p.catch(() => undefined),
  };

  const handle = serveStdio(() => buildMcpServer(ctx), { onerror: (e) => log(`transport error: ${e.message}`) });
  log(`serving ${who.fullname} (${readOnly ? 'read-only' : 'read + write'}).`);

  const stop = () => {
    void handle.close().finally(() => store.flush().finally(() => process.exit(0)));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

async function run(cmd: Command): Promise<void> {
  switch (cmd.kind) {
    case 'help':
      return out(USAGE);
    case 'version':
      return out(SERVER_VERSION);
    case 'connect':
      return connectCommand(cmd.input);
    default:
      return serveCommand(cmd.readOnly);
  }
}

function report(e: unknown): string {
  if (e instanceof NeedsReconnect) return RECONNECT_STDIO;
  return e instanceof WmmError ? e.message : `Unexpected error (${e instanceof Error ? e.name : typeof e}).`;
}

function main(): Promise<void> {
  let cmd: Command;
  try {
    cmd = parseArgs(process.argv.slice(2));
  } catch (e) {
    log(`${report(e)}\n\n${USAGE}`);
    process.exit(2);
  }
  return run(cmd);
}

main().catch((e: unknown) => {
  log(report(e));
  process.exit(1);
});
