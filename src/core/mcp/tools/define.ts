import type { ContentBlock, ToolAnnotations } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { ServiceContext } from '../../context';

interface ToolOut {
  text: string;
  /** structuredContent: an object (list results are wrapped by the tool). */
  data: object;
  extra?: ContentBlock[];
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  /** Model-facing: when to use the tool, caveats. */
  description: string;
  annotations: ToolAnnotations;
  input: S;
  /** structuredContent shape; the SDK validates every result against it, so keep it permissive (see ../schemas). */
  output: z.ZodType;
  run(ctx: ServiceContext, args: z.output<S>): Promise<ToolOut>;
}

/** Identity helper that lets TypeScript infer `args` in `run` from the zod input schema. */
export const defineTool = <S extends z.ZodType>(def: ToolDef<S>): ToolDef<S> => def;

export const READ_HINTS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** Changes only our own stored selection, never anything in Moodle. */
export const LOCAL_SETTING_HINTS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const PREPARE_HINTS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

export const id = (describe: string) => z.number().int().positive().describe(describe);
export const limit = (describe: string, max: number) => z.number().int().min(1).max(max).describe(describe);
