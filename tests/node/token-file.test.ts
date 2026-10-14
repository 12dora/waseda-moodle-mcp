import { readdirSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvalidInput } from '../../src/core/errors';
import { readStdin, readToken, writeToken } from '../../src/node/token-file';

const TOKEN = '0123456789abcdef0123456789abcdef';
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wmm-tok-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('token file', () => {
  it('writes mode 0600 atomically and reads it back', async () => {
    const file = join(dir, 'conf', 'token');
    await writeToken(file, TOKEN);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, 'conf'))).toEqual(['token']); // no tmp file left behind
    expect(await readFile(file, 'utf8')).toBe(`${TOKEN}\n`);
    expect(await readToken(file, {})).toBe(TOKEN);
  });

  it('prefers WMM_TOKEN and explains a missing token', async () => {
    expect(await readToken(join(dir, 'none'), { WMM_TOKEN: TOKEN })).toBe(TOKEN);
    await expect(readToken(join(dir, 'none'), {})).rejects.toThrow(InvalidInput);
  });

  it('reads a launch link from a stream', async () => {
    expect(await readStdin(Readable.from([` ltgopenlmsapp://token=abc`, '\n']))).toBe('ltgopenlmsapp://token=abc');
  });
});
