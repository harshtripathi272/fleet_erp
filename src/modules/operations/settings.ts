import { requireArea } from '../company/areas.js';
import { DEFAULT_AREAS } from '../company/areaList.js';
import { Company, OPERATIONS_DEFAULTS } from '../company/company.model.js';

export type OperationsSettings = { -readonly [K in keyof typeof OPERATIONS_DEFAULTS]: (typeof OPERATIONS_DEFAULTS)[K] extends boolean ? boolean : (typeof OPERATIONS_DEFAULTS)[K] extends number ? number : (typeof OPERATIONS_DEFAULTS)[K] extends string[] ? string[] : string };

/** This company's switched-on modules and trip settings, with the defaults filling any gap. */
export async function companySettings(): Promise<{ modules: string[]; operations: OperationsSettings }> {
  const company = await Company.findOne().select('modules operations').lean();
  return {
    modules: (company?.modules as string[] | undefined) ?? DEFAULT_AREAS,
    operations: { ...OPERATIONS_DEFAULTS, ...((company?.operations as Partial<OperationsSettings> | undefined) ?? {}) },
  };
}

export const operationsSettings = async () => (await companySettings()).operations;

/** Refuses requests to an area the company has switched off (#56). */
export const requireModule = (module: 'trips' | 'finance' | 'tracking' | 'driver-app') => requireArea(module);
