import type { RequestHandler } from 'express';
import { ForbiddenError, UnauthorizedError } from '../core/errors/index.js';
import type { Action } from '../core/masters/types.js';

/** Allows the request only when one of the user's roles grants `action` on `resource`. */
export const authorize = (resource: string, action: Action): RequestHandler => Object.assign<RequestHandler, { meta: object }>((req, _res, next) => {
  if (!req.auth) throw new UnauthorizedError();
  if (!req.auth.can(resource, action)) throw new ForbiddenError(`Your role does not allow "${action}" on ${resource}`);
  next();
}, { meta: { permission: { resource, action } } });

export function permissionChecker(permissions: Array<{ resource: string; actions: string[] }>) {
  return (resource: string, action: Action) => permissions.some((p) =>
    (p.resource === '*' || p.resource === resource) && (p.actions.includes('*') || p.actions.includes(action)));
}
