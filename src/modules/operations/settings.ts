import type { RequestHandler } from 'express';
import { ForbiddenError } from '../../core/errors/index.js';
import { Company, OPERATIONS_DEFAULTS } from '../company/company.model.js';

export type OperationsSettings = { -readonly [K in keyof typeof OPERATIONS_DEFAULTS]: (typeof OPERATIONS_DEFAULTS)[K] extends boolean ? boolean : (typeof OPERATIONS_DEFAULTS)[K] extends number ? number : string };

/** This company's switched-on modules and trip settings, with the defaults filling any gap. */
export async function companySettings(): Promise<{ modules: string[]; operations: OperationsSettings }> {
  const company = await Company.findOne().select('modules operations').lean();
  return {
    modules: (company?.modules as string[] | undefined) ?? ['masters', 'trips'],
    operations: { ...OPERATIONS_DEFAULTS, ...((company?.operations as Partial<OperationsSettings> | undefined) ?? {}) },
  };
}

export const operationsSettings = async () => (await companySettings()).operations;

const MODULE_NAMES: Record<string, string> = { trips: 'Trips', finance: 'Finance', tracking: 'Tracking' };

/** Refuses requests to an area whose module the company has switched off (company `modules`). */
export const requireModule = (module: 'trips' | 'finance' | 'tracking'): RequestHandler => Object.assign<RequestHandler, { meta: object }>(async (_req, _res, next) => {
  const { modules } = await companySettings();
  if (!modules.includes(module)) throw new ForbiddenError(`The ${MODULE_NAMES[module]} module is switched off for this company`);
  next();
}, { meta: { module } });
