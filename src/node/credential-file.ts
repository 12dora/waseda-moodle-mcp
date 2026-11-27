/** The saved Moodle sign-in on disk: a small JSON file, mode 0600, replaced atomically. */

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { InvalidInput } from '../core/errors';
import { parseLaunch } from '../core/moodle/launch';
import { normalizeSessionCookie } from '../core/moodle/web/identify';

/** Everything stored belongs to one Moodle user. */
export interface Credential {
  /** Moodle app token (works while the app service is on). */
  token?: string;
  /** Web session cookie, `MoodleSession=<value>`. */
  session?: string;
  sesskey?: string;
  moodleUserId?: number;
}

export interface LoadedCredential {
  credential: Credential;
  /** The file changes are written back to; null when the credential came from the environment. */
  file: string | null;
}

type Env = Record<string, string | undefined>;

const NO_CREDENTIAL =
  'No Moodle sign-in found. Run: waseda-moodle-mcp connect (see --help), or set WMM_SESSION or WMM_TOKEN.';
const DAMAGED = 'The saved Moodle sign-in cannot be read. Run: waseda-moodle-mcp connect';

const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

function parseJsonCredential(raw: string): Credential {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new InvalidInput(DAMAGED);
  }
  const userId = data.moodleUserId;
  return {
    token: text(data.token),
    session: text(data.session),
    sesskey: text(data.sesskey),
    moodleUserId: typeof userId === 'number' && userId > 0 ? userId : undefined,
  };
}

/** The saved credential, or null when there is no file. A file holding just a token (or launch link) is read too. */
export async function readCredentialFile(file: string): Promise<Credential | null> {
  let raw: string;
  try {
    raw = (await readFile(file, 'utf8')).trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new InvalidInput(DAMAGED);
  }
  return raw.startsWith('{') ? parseJsonCredential(raw) : { token: parseLaunch(raw).token };
}

function envCredential(env: Env): Credential | null {
  const token = env.WMM_TOKEN?.trim();
  const session = env.WMM_SESSION?.trim();
  if (!token && !session) return null;
  return {
    token: token ? parseLaunch(token).token : undefined,
    session: session ? normalizeSessionCookie(session) : undefined,
  };
}

/** WMM_SESSION / WMM_TOKEN win over the file (as a whole, so two accounts are never mixed). */
export async function loadCredential(file: string, env: Env = process.env): Promise<LoadedCredential> {
  const fromEnv = envCredential(env);
  if (fromEnv) return { credential: fromEnv, file: null };
  const saved = await readCredentialFile(file);
  if (!saved?.token && !saved?.session) throw new InvalidInput(NO_CREDENTIAL);
  return { credential: saved, file };
}

export async function writeCredential(file: string, credential: Credential): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/**
 * The running server's write-back: applies `change` only while the file still holds the cookie `from`, so it never
 * overwrites what a newer `connect` saved.
 */
export async function replaceSession(
  file: string,
  from: string,
  change: Pick<Credential, 'session' | 'sesskey'>,
): Promise<void> {
  const saved = await readCredentialFile(file);
  if (saved?.session !== from) return;
  await writeCredential(file, { ...saved, ...change });
}

/** Reads the whole of stdin (the value piped in, so it never lands in shell history). */
export async function readStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8').trim();
}
