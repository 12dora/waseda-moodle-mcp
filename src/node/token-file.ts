/** The Moodle token on disk: one line, mode 0600, replaced atomically. */

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { InvalidInput } from '../core/errors';
import { parseLaunch } from '../core/moodle/launch';

/** WMM_TOKEN (token or launch link) wins over the file. */
export async function readToken(file: string, env: Record<string, string | undefined> = process.env): Promise<string> {
  const fromEnv = env.WMM_TOKEN?.trim();
  if (fromEnv) return parseLaunch(fromEnv).token;
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    throw new InvalidInput(
      'No Moodle token found. Set WMM_TOKEN, or run: waseda-moodle-mcp connect (it explains how to get the link).',
    );
  }
  return parseLaunch(raw).token;
}

export async function writeToken(file: string, token: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, `${token}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** Reads the whole of stdin (the launch link piped in, so it never lands in shell history). */
export async function readStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8').trim();
}
