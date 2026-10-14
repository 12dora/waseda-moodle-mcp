import { InvalidInput } from '../errors';

export function requirePositiveInt(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new InvalidInput(`${name} must be a positive integer.`);
  return value;
}

/** `undefined` passes through; anything else must be a positive integer. */
export function optionalPositiveInt(value: number | undefined, name: string): number | undefined {
  return value === undefined ? undefined : requirePositiveInt(value, name);
}
