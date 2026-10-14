import type { RequestHandler } from 'express';
import { z } from 'zod';
import { ValidationError } from '../core/errors/index.js';

type Target = 'body' | 'query' | 'params';
export const validate = (schemas: Partial<Record<Target, z.ZodType>>): RequestHandler => async (req, _res, next) => {
  const parsed: Partial<Record<Target, unknown>> = {};
  const errors: Partial<Record<Target, unknown>> = {};
  for (const target of ['body', 'query', 'params'] as const) {
    const schema = schemas[target];
    if (!schema) continue;
    const result = await schema.safeParseAsync(req[target]);
    if (result.success) parsed[target] = result.data;
    else errors[target] = z.flattenError(result.error);
  }
  if (Object.keys(errors).length) throw new ValidationError('Validation failed', errors);
  for (const target of Object.keys(parsed) as Target[]) {
    // Express 5 exposes query as a getter; a request-local property preserves the guide's contract.
    Object.defineProperty(req, target, { value: parsed[target], writable: true, configurable: true, enumerable: true });
  }
  next();
};
