import { readdirSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvalidInput } from '../../src/core/errors';
import {
  loadCredential,
  readCredentialFile,
  readStdin,
  replaceSession,
  writeCredential,
} from '../../src/node/credential-file';

const TOKEN = '0123456789abcdef0123456789abcdef';
const SESSION = 'MoodleSession=abcdefghij0123456789klmnop';
const NEXT = 'MoodleSession=zyxwvutsrq9876543210ponmlk';
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wmm-cred-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('credential file', () => {
  it('writes mode 0600 atomically and reads it back', async () => {
    const file = join(dir, 'conf', 'token');
    const credential = { session: SESSION, sesskey: 'KeyKey1234', moodleUserId: 7001, token: TOKEN };
    await writeCredential(file, credential);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, 'conf'))).toEqual(['token']); // no tmp file left behind
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(credential);
    expect(await loadCredential(file, {})).toEqual({ credential, file });
  });

  it('reads the plain token (or launch link) file', async () => {
    const file = join(dir, 'token');
    await writeFile(file, `${TOKEN}\n`);
    expect(await readCredentialFile(file)).toEqual({ token: TOKEN });
    await writeFile(file, `ltgopenlmsapp://token=${TOKEN}\n`);
    expect(await readCredentialFile(file)).toEqual({ token: TOKEN });
  });

  it('lets the environment replace the file as a whole', async () => {
    const file = join(dir, 'token');
    await writeCredential(file, { token: TOKEN, moodleUserId: 7001 });
    const loaded = await loadCredential(file, { WMM_SESSION: 'abcdefghij0123456789klmnop' });
    expect(loaded.file).toBeNull();
    expect(loaded.credential).toEqual({ session: SESSION });
    expect((await loadCredential(join(dir, 'none'), { WMM_TOKEN: TOKEN })).credential).toEqual({ token: TOKEN });
  });

  it('explains a missing, emptied or damaged sign-in', async () => {
    const file = join(dir, 'token');
    expect(await readCredentialFile(file)).toBeNull();
    await expect(loadCredential(file, {})).rejects.toThrow(/waseda-moodle-mcp connect/);
    await writeCredential(file, { moodleUserId: 7001 });
    await expect(loadCredential(file, {})).rejects.toThrow(InvalidInput);
    await writeFile(file, '{ not json');
    await expect(loadCredential(file, {})).rejects.toThrow(/cannot be read/);
  });

  it('replaces the session only while the file still holds the cookie it came from', async () => {
    const file = join(dir, 'token');
    await writeCredential(file, { session: SESSION, token: TOKEN, moodleUserId: 7001 });
    await replaceSession(file, NEXT, { session: undefined, sesskey: undefined });
    expect((await readCredentialFile(file))?.session).toBe(SESSION);
    await replaceSession(file, SESSION, { session: NEXT, sesskey: 'KeyKey1234' });
    expect(await readCredentialFile(file)).toEqual({
      session: NEXT,
      sesskey: 'KeyKey1234',
      token: TOKEN,
      moodleUserId: 7001,
    });
    await replaceSession(file, NEXT, { session: undefined, sesskey: undefined });
    expect(await readCredentialFile(file)).toEqual({ token: TOKEN, moodleUserId: 7001 });
  });

  it('reads a pasted value from a stream', async () => {
    expect(await readStdin(Readable.from([` ${SESSION}`, '\n']))).toBe(SESSION);
  });
});
