import type { RequestHandler } from 'express';
import { ForbiddenError } from '../../core/errors/index.js';
import { setAreaCheck } from '../../core/masters/areaCheck.js';
import { Company } from './company.model.js';

/**
 * Whether an area of the business is on (#56). An area that is off refuses new work, hides its masters, desks and
 * menu items, and keeps its notification rules quiet; what was recorded in it is kept and comes back when it is
 * switched on again. The areas themselves are listed in areaList.ts; a new area is one entry there.
 */
import { AREAS, DEFAULT_AREAS, areaOf, type AreaKey } from './areaList.js';
export { AREAS, AREA_KEYS, DEFAULT_AREAS, areaOf, type Area, type AreaKey, type AreaState } from './areaList.js';

/**
 * Message events by area: an event of an area that is off sends nothing.
 * Events not listed here (documents, sign-in) belong to every company.
 */
const EVENT_AREAS: [RegExp, AreaKey][] = [
  [/^(trip|nomination)\./, 'trips'],
  [/^(fund_request|expense|settlement)\./, 'finance'],
  [/^(invoice|payment)\./, 'billing'],
  [/^(service|work_order)\./, 'maintenance'],
];
export const areaOfEvent = (event: string) => EVENT_AREAS.find(([re]) => re.test(event))?.[1];

/** The areas this company has on. Areas that are always on, or not built, are settled here, not stored. */
export async function areasOn(): Promise<Set<string>> {
  const company = await Company.findOne().select('modules').lean<{ modules?: string[] }>();
  const chosen = company?.modules ?? DEFAULT_AREAS;
  const on = (a: (typeof AREAS)[number]) => ('always' in a && a.always) || (a.state !== 'not-built' && chosen.includes(a.key));
  return new Set(AREAS.filter((a) => on(a) && (!('within' in a) || chosen.includes(a.within))).map((a) => a.key));
}
export const isAreaOn = async (key: string) => (await areasOn()).has(key);

const offMessage = (key: string) => `${areaOf(key)?.name ?? key} is switched off for this company. An owner can switch it on in Company → Areas switched on.`;

/** Refuses requests to an area the company has switched off. */
export const requireArea = (key: AreaKey): RequestHandler => Object.assign<RequestHandler, { meta: object }>(async (_req, _res, next) => {
  if (!(await isAreaOn(key))) throw new ForbiddenError(offMessage(key));
  next();
}, { meta: { module: key } });

// Masters that belong to an area refuse while it is off.
setAreaCheck(async (key) => {
  if (!(await isAreaOn(key))) throw new ForbiddenError(offMessage(key));
});
