import type { RequestHandler } from 'express';
import { ForbiddenError, UnauthorizedError } from '../core/errors/index.js';
import { verifyAccessToken } from '../core/security/jwt.js';
import { Session } from '../modules/auth/session.model.js';
import { Role } from '../modules/roles/role.model.js';
import { User } from '../modules/users/user.model.js';
import { permissionChecker } from './authorize.js';

/** Requires `Authorization: Bearer <access token>` for an active user and live session. */
export const authenticate: RequestHandler = Object.assign<RequestHandler, { meta: object }>(async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new UnauthorizedError('Sign in to continue');
  const claims = verifyAccessToken(header.slice(7).trim());
  if (!claims) throw new UnauthorizedError('Session expired or invalid. Sign in again.');
  if (!/^[0-9a-f]{24}$/.test(claims.sub) || !/^[0-9a-f]{24}$/.test(claims.sid)) throw new UnauthorizedError('Session expired or invalid. Sign in again.');
  const [user, session] = await Promise.all([
    User.findById(claims.sub).select('status tokenVersion email name roleIds driverId mustChangePassword').lean(),
    Session.exists({ _id: claims.sid, userId: claims.sub, revokedAt: null, expiresAt: { $gt: new Date() } }),
  ]);
  if (!user || user.status !== 'active' || user.tokenVersion !== claims.tv || !session) {
    throw new UnauthorizedError('Session expired or invalid. Sign in again.');
  }
  // Enforced here, not only on the screen: until it's replaced, a password someone else knows opens nothing but the sign-in routes.
  if (user.mustChangePassword && !req.originalUrl.startsWith('/api/v1/auth/')) throw new ForbiddenError('Choose a new password first');
  const roles = await Role.find({ _id: { $in: user.roleIds ?? [] }, status: 'active' }).select('key permissions').lean();
  const permissions = roles.flatMap((r) => (r.permissions ?? []).map((p) => ({ resource: p.resource, actions: [...p.actions] })));
  req.auth = {
    userId: claims.sub,
    sessionId: claims.sid,
    email: user.email,
    driverId: user.driverId ? String(user.driverId) : undefined,
    name: user.name,
    roles: roles.map((r) => r.key),
    permissions,
    can: permissionChecker(permissions),
  };
  next();
}, { meta: { authenticated: true } });
