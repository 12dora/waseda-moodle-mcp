/** Command line of the local entry: strict, so a typo like --readonly never silently enables write tools. */

import { InvalidInput } from '../core/errors';

export type Command =
  | { kind: 'help' }
  | { kind: 'version' }
  /** input null = read the launch link from stdin. */
  | { kind: 'connect'; input: string | null }
  | { kind: 'serve'; readOnly: boolean };

const truthy = (v: string | undefined) => ['1', 'true'].includes((v ?? '').toLowerCase());

function parseConnect(args: string[]): Command {
  const flag = args.find((a) => a.startsWith('--'));
  if (flag) throw new InvalidInput(`Unknown option "${flag}" for connect.`);
  if (args.length === 0 || (args.length === 1 && args[0] === '-')) return { kind: 'connect', input: null };
  return { kind: 'connect', input: args.join(' ').trim() };
}

function parseServe(args: string[], env: Record<string, string | undefined>): Command {
  let readOnly = truthy(env.WMM_READ_ONLY);
  for (const a of args) {
    if (a === '--read-only') readOnly = true;
    else if (a.startsWith('-')) throw new InvalidInput(`Unknown option "${a}".`);
    else throw new InvalidInput(`Unexpected argument "${a}".`);
  }
  return { kind: 'serve', readOnly };
}

export function parseArgs(argv: string[], env: Record<string, string | undefined> = process.env): Command {
  const [first, ...rest] = argv;
  if (first === '--help' || first === '-h' || first === 'help') return { kind: 'help' };
  if (first === '--version' || first === '-v') return { kind: 'version' };
  if (first === 'connect') return parseConnect(rest);
  return parseServe(argv, env);
}
