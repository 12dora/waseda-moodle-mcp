import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvalidInput } from '../../src/core/errors';
import { resolveInlineFiles } from '../../src/core/services/actions/inline-files';
import { makeFakeContext } from '../helpers/fake-context';

const LIMIT = 1024 * 1024;
let root: string;
let configDir: string;
const saved = process.env.WMM_CONFIG_DIR;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'wmm-path-')));
  configDir = join(root, 'cfg');
  await mkdir(configDir);
  process.env.WMM_CONFIG_DIR = configDir;
});
afterEach(async () => {
  if (saved === undefined) delete process.env.WMM_CONFIG_DIR;
  else process.env.WMM_CONFIG_DIR = saved;
  await rm(root, { recursive: true, force: true });
});

const stdio = () => makeFakeContext({ mode: 'stdio', publicUrl: '' }).ctx;
const load = (path: string) => resolveInlineFiles(stdio(), [{ name: 'report.txt', path }], LIMIT);

describe('local paths in stdio mode', () => {
  it('reads a normal file and reports its real path', async () => {
    const file = join(root, 'report.txt');
    await writeFile(file, 'hello');
    const [f] = await load(file);
    expect(f?.size).toBe(5);
    expect(f?.source).toBe(file);
  });

  it('resolves a symlink and shows the real source', async () => {
    const real = join(root, 'real.txt');
    await writeFile(real, 'hello');
    const link = join(root, 'link.txt');
    await symlink(real, link);
    const [f] = await load(link);
    expect(f?.source).toBe(real);
  });

  it('refuses dotfiles and files inside dot-directories', async () => {
    await mkdir(join(root, '.ssh'));
    await writeFile(join(root, '.ssh', 'id_rsa'), 'secret');
    await writeFile(join(root, '.env'), 'secret');
    await expect(load(join(root, '.ssh', 'id_rsa'))).rejects.toThrow(/hidden files and folders/);
    await expect(load(join(root, '.env'))).rejects.toThrow(InvalidInput);
  });

  it('refuses a symlink that points into a hidden folder or the config folder', async () => {
    await mkdir(join(root, '.hidden'));
    await writeFile(join(root, '.hidden', 'a.txt'), 'x');
    await symlink(join(root, '.hidden', 'a.txt'), join(root, 'innocent.txt'));
    await expect(load(join(root, 'innocent.txt'))).rejects.toThrow(/hidden files and folders/);

    await writeFile(join(configDir, 'token'), 'abcd');
    await expect(load(join(configDir, 'token'))).rejects.toThrow(/config folder/);
    await symlink(join(configDir, 'token'), join(root, 'looks-fine.txt'));
    await expect(load(join(root, 'looks-fine.txt'))).rejects.toThrow(/config folder/);
  });

  it('keeps the existing checks: absolute path, existence, mode', async () => {
    await expect(load('relative/file.txt')).rejects.toThrow(/absolute/);
    await expect(load(join(root, 'missing.txt'))).rejects.toThrow(/not found/);
    const worker = makeFakeContext({ mode: 'worker' }).ctx;
    await expect(resolveInlineFiles(worker, [{ name: 'a.txt', path: join(root, 'a.txt') }], LIMIT)).rejects.toThrow(
      /only supported in local/,
    );
  });
});
