/**
 * Local single-user entry: MCP over stdio, talking to Waseda Moodle with the user's own sign-in.
 *
 *   waseda-moodle-mcp                        serve (reads WMM_SESSION / WMM_TOKEN or the saved sign-in)
 *   waseda-moodle-mcp --read-only            same, without the write tools (or WMM_READ_ONLY=1)
 *   waseda-moodle-mcp connect ["<value>"]    save a session cookie or launch link (argument or stdin)
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
import { MOODLE_URL } from '../core/moodle/launch';
import type { Scope } from '../core/types';
import { type Command, parseArgs } from './args';
import { connect } from './connect';
import { loadCredential, readStdin } from './credential-file';
import { LiveConnection } from './live-connection';
import { createMoodleProvider, ReadCache } from './moodle-session';
import { makeProxyFetch } from './proxy';
import { MemoryStore } from './store-memory';

const CONFIG_DIR = process.env.WMM_CONFIG_DIR || join(homedir(), '.config', 'waseda-moodle-mcp');
/** The name predates the web session; the file now holds the whole sign-in (credential-file.ts). */
const CREDENTIAL_FILE = join(CONFIG_DIR, 'token');
const STATE_FILE = join(CONFIG_DIR, 'state.json');

const log = (msg: string) => console.error(`[waseda-moodle-mcp] ${msg}`);

const USAGE = `waseda-moodle-mcp ${SERVER_VERSION}

Usage:
  waseda-moodle-mcp [--read-only]       Run the MCP server on stdio.
  waseda-moodle-mcp connect ["<value>"] Save your Moodle sign-in (mode 0600) in ${CREDENTIAL_FILE}.
                                        Without an argument (or with "-") the value is read from stdin.

How to copy the session cookie:
  1. Sign in to Waseda Moodle (${MOODLE_URL}).
  2. Open the developer tools (F12; Option+Command+I on a Mac), then Application
     (Firefox and Safari: Storage) > Cookies > ${MOODLE_URL}.
  3. Copy the value of MoodleSession, run "waseda-moodle-mcp connect", paste it and press Ctrl-D.
Treat this value like a password. The running server keeps the session alive; signing out of Moodle ends it.
A Moodle app launch link (ltgopenlmsapp://...) also works while Waseda's app service is on.

Environment: WMM_SESSION (cookie) and WMM_TOKEN (token or link) replace the saved file, WMM_READ_ONLY=1,
WMM_CONFIG_DIR, HTTPS_PROXY / ALL_PROXY / NO_PROXY.`;

const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

const moodleFetch = (): typeof fetch => makeProxyFetch() ?? ((input, init) => globalThis.fetch(input, init));

async function connectCommand(input: string | null): Promise<void> {
  const value = input ?? (await readStdin());
  if (!value) throw new InvalidInput('No value given. Pass the MoodleSession value or pipe it in (see --help).');
  const { fullname, credential } = await connect(value, { file: CREDENTIAL_FILE, fetch: moodleFetch() });
  const saved = [credential.session && 'Moodle session', credential.token && 'app token'].filter(Boolean);
  out(`Connected to Waseda Moodle as ${fullname}. Saved the ${saved.join(' and ')} to ${CREDENTIAL_FILE}.`);
  if (process.env.WMM_SESSION || process.env.WMM_TOKEN) {
    out('Note: WMM_SESSION / WMM_TOKEN are set and replace the saved file; unset them to use it.');
  }
}

async function serveCommand(readOnly: boolean): Promise<void> {
  const loaded = await loadCredential(CREDENTIAL_FILE);
  const cache = new ReadCache();
  const connection = new LiveConnection({ ...loaded, fetch: moodleFetch(), log, onChange: () => cache.clear() });
  const who = await connection.start();

  const store = new MemoryStore({
    persistPath: STATE_FILE,
    onPersistError: () => log(`Could not read or write ${STATE_FILE}; settings and pending actions are not persisted.`),
  });
  const user = await store.upsertUser(who);
  const signer = createSigner(await importMasterKey(b64urlEncode(crypto.getRandomValues(new Uint8Array(32)))));
  const scopes: Scope[] = readOnly ? ['moodle:read'] : ['moodle:read', 'moodle:write'];
  const ctx: ServiceContext = {
    user,
    store,
    signer,
    moodle: createMoodleProvider(() => connection.clientOptions(), cache),
    publicUrl: '',
    mode: 'stdio',
    scopes,
    source: 'Local',
    defer: (p) => void p.catch(() => undefined),
  };

  const handle = serveStdio(() => buildMcpServer(ctx), { onerror: (e) => log(`transport error: ${e.message}`) });
  log(`serving ${who.fullname} (${readOnly ? 'read-only' : 'read + write'}).`);

  const stop = () => {
    connection.stop();
    const saved = () => Promise.all([store.flush(), connection.flush()]);
    void handle.close().finally(() => saved().finally(() => process.exit(0)));
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
