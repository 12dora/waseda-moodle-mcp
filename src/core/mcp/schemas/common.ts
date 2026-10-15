/**
 * Output schemas describe structuredContent for clients. The SDK validates every result against them and a mismatch
 * turns a working tool into an error, so they stay permissive: top-level keys that are always present with their
 * primitive types, nested objects loose, and only identifying keys listed inside arrays of objects.
 */
import * as z from 'zod';

/** An array of loose objects that must at least carry the listed keys. */
export const list = <S extends z.core.$ZodLooseShape>(shape: S) => z.array(z.looseObject(shape));
