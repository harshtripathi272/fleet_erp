import type { RequestHandler } from 'express';

/**
 * A master can belong to an area of the business (`module` on its definition) that a company switches on and off.
 * The company module supplies the check, so the masters core does not depend on it; until it does, nothing is refused.
 */
type Check = (area: string) => Promise<void>;
let check: Check = async () => {};
export const setAreaCheck = (fn: Check) => { check = fn; };

/** Refuses every request to a master whose area is switched off. */
export const areaGuard = (area: string): RequestHandler => async (_req, _res, next) => {
  try {
    await check(area);
    next();
  } catch (err) {
    next(err);
  }
};
