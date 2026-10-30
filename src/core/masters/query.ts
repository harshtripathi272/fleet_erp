import { z } from 'zod';
import { isoDate } from './zod.js';
import type { MasterDefinition } from './types.js';

export const pageQuery = z.strictObject({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** Query-string schema for a master's list endpoint (strict: unknown parameters are rejected). */
export function listQuerySchema(def: MasterDefinition) {
  const sorts = def.sortFields.flatMap((f) => [f, `-${f}`]) as [string, ...string[]];
  const filters = Object.fromEntries(Object.entries(def.filters ?? {}).map(([k, f]) => [k, f.schema.optional()]));
  return z.strictObject({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().trim().min(1).max(100).optional(),
    status: z.enum(['active', 'inactive', 'archived', 'all']).optional(),
    sort: z.enum(sorts).optional(),
    updatedSince: isoDate.optional(),
    ...filters,
  });
}

/** Query helpers for filters: "true"/"false" strings and comma-separated id lists. */
export const boolQuery = z.enum(['true', 'false']).transform((v) => v === 'true');
export const idQuery = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a record id').transform((v) => v.toLowerCase());
