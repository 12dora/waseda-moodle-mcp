import { describe, expect, it } from 'vitest';
import { InvalidInput } from '../../src/core/errors';
import { parseArgs } from '../../src/node/args';

describe('parseArgs', () => {
  it('serves by default and honours --read-only and WMM_READ_ONLY', () => {
    expect(parseArgs([], {})).toEqual({ kind: 'serve', readOnly: false });
    expect(parseArgs(['--read-only'], {})).toEqual({ kind: 'serve', readOnly: true });
    expect(parseArgs([], { WMM_READ_ONLY: '1' })).toEqual({ kind: 'serve', readOnly: true });
    expect(parseArgs([], { WMM_READ_ONLY: 'TRUE' })).toEqual({ kind: 'serve', readOnly: true });
    expect(parseArgs([], { WMM_READ_ONLY: '0' })).toEqual({ kind: 'serve', readOnly: false });
  });

  it('rejects unknown flags and stray arguments instead of ignoring them', () => {
    expect(() => parseArgs(['--readonly'], {})).toThrow(InvalidInput);
    expect(() => parseArgs(['--readonly'], {})).toThrow(/Unknown option "--readonly"/);
    expect(() => parseArgs(['-x'], {})).toThrow(/Unknown option/);
    expect(() => parseArgs(['serve'], {})).toThrow(/Unexpected argument "serve"/);
  });

  it('parses help and version', () => {
    for (const a of ['--help', '-h', 'help']) expect(parseArgs([a], {})).toEqual({ kind: 'help' });
    for (const a of ['--version', '-v']) expect(parseArgs([a], {})).toEqual({ kind: 'version' });
  });

  it('connect takes a link, "-" or nothing (stdin)', () => {
    expect(parseArgs(['connect', 'ltgopenlmsapp://token=abc'], {})).toEqual({
      kind: 'connect',
      input: 'ltgopenlmsapp://token=abc',
    });
    expect(parseArgs(['connect'], {})).toEqual({ kind: 'connect', input: null });
    expect(parseArgs(['connect', '-'], {})).toEqual({ kind: 'connect', input: null });
    expect(() => parseArgs(['connect', '--force'], {})).toThrow(/Unknown option "--force" for connect/);
  });
});
