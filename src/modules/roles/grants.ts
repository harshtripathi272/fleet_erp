import { ForbiddenError } from '../../core/errors/index.js';
import type { Plain } from '../../core/masters/types.js';
import { User } from '../users/user.model.js';
import { Role } from './role.model.js';

type Permission = { resource: string; actions: string[] };

async function actorAccess(actorId: string | undefined) {
  if (!actorId) return { isOwner: true, covers: () => true };
  const user = await User.findById(actorId).select('roleIds').lean();
  const roles = await Role.find({ _id: { $in: user?.roleIds ?? [] }, status: 'active' }).select('key permissions').lean();
  const permissions = roles.flatMap((r) => (r.permissions ?? []) as Permission[]);
  /** True when one of the actor's grants includes `action` on `resource` ('*' only matches '*'). */
  const holds = (resource: string, action: string) => permissions.some((own) =>
    (own.resource === '*' || own.resource === resource) && (own.actions.includes('*') || own.actions.includes(action)) && (action !== '*' || own.actions.includes('*')));
  const covers = (p: Permission) => p.actions.every((a) => (p.resource === '*'
    ? permissions.some((own) => own.resource === '*' && (own.actions.includes('*') || (a !== '*' && own.actions.includes(a))))
    : holds(p.resource, a)));
  return { isOwner: roles.some((r) => r.key === 'owner'), covers };
}

/** Nobody can hand out permissions they do not hold themselves. */
export async function assertCanGrantPermissions(actorId: string | undefined, permissions: Permission[]) {
  const access = await actorAccess(actorId);
  const beyond = permissions.filter((p) => !access.covers(p));
  if (beyond.length) throw new ForbiddenError('You cannot grant permissions you do not hold', { permissions: beyond.map((p) => `${p.resource}:${p.actions.join(',')}`) });
}

/** Assigning roles: the actor must hold every permission of each added role; only owners grant or remove Owner. */
export async function assertCanAssignRoles(actorId: string | undefined, before: unknown[], after: unknown[]) {
  const was = new Set(before.map(String));
  const now = new Set(after.map(String));
  const changed = [...new Set([...was, ...now])].filter((id) => was.has(id) !== now.has(id));
  if (!changed.length) return;
  const roles = await Role.find({ _id: { $in: changed } }).lean();
  const access = await actorAccess(actorId);
  if (roles.some((r) => r.key === 'owner') && !access.isOwner) throw new ForbiddenError('Only an owner can grant or remove the Owner role');
  for (const role of roles.filter((r) => now.has(String(r._id)))) {
    const beyond = (role.permissions ?? []).filter((p) => !access.covers(p as Permission));
    if (beyond.length) throw new ForbiddenError(`You cannot assign the ${role.name} role: it grants permissions you do not hold`);
  }
}

export const permissionsOf = (data: Plain) => (data.permissions ?? []) as Permission[];
