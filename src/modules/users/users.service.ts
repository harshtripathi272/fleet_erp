import { Types } from 'mongoose';
import { ConflictError } from '../../core/errors/index.js';
import { audit } from '../../core/masters/audit.js';
import { GROUPS } from '../../core/masters/groups.js';
import { create as createRecord, type ServiceContext } from '../../core/masters/service.js';
import type { MasterDefinition, Plain } from '../../core/masters/types.js';
import { hashPassword } from '../../core/security/password.js';
import { randomToken } from '../../core/security/tokens.js';
import { Session } from '../auth/session.model.js';
import { Role } from '../roles/role.model.js';
import { User } from './user.model.js';
import { createUserSchema, updateUserSchema } from './users.schema.js';
import { issuePasswordReset } from '../auth/auth.service.js';
import { assertCanAssignRoles } from '../roles/grants.js';

async function ownerRoleId(): Promise<string | null> {
  const role = await Role.findOne({ key: 'owner' }).select('_id').lean();
  return role ? String(role._id) : null;
}

const hasRole = (roleIds: unknown, roleId: string | null) =>
  !!roleId && Array.isArray(roleIds) && roleIds.some((r) => String(r) === roleId);

/** Refuses a change that would leave the company without an active owner. */
async function assertOwnerRemains(userId: string, stillOwner: boolean) {
  const ownerId = await ownerRoleId();
  if (stillOwner || !ownerId) return;
  const others = await User.countDocuments({ _id: { $ne: userId }, status: 'active', roleIds: ownerId });
  if (!others) throw new ConflictError('At least one active owner must remain. Make another user an owner first.');
}

export async function revokeSessions(userId: string, bumpTokenVersion = true) {
  await Session.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: 'revoked' } });
  if (bumpTokenVersion) await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
}

export const userDefinition: MasterDefinition = {
  key: 'users',
  label: 'Users',
  singular: 'User',
  group: GROUPS.organisation,
  description: 'People who sign in. Each user holds one or more roles; at least one active owner must always remain.',
  model: User,
  createSchema: createUserSchema,
  updateSchema: updateUserSchema,
  searchFields: ['name', 'email', 'phone'],
  columns: ['email', 'phone', 'roleIds'],
  sortFields: ['name', 'email', 'lastLoginAt', 'createdAt', 'updatedAt'],
  hidden: ['passwordHash', 'tokenVersion', 'failedLoginCount'],
  refs: [{ path: 'roleIds', target: 'roles' }],
  managed: { create: true, delete: true },
  async prepare(data: Plain, ctx) {
    await assertCanAssignRoles(ctx.actorId, (ctx.existing?.roleIds ?? []) as unknown[], (data.roleIds ?? []) as unknown[]);
    if (ctx.mode === 'update' && ctx.existing && ctx.id) {
      const ownerId = await ownerRoleId();
      const wasOwner = hasRole(ctx.existing.roleIds, ownerId) && ctx.existing.status === 'active';
      if (wasOwner) await assertOwnerRemains(ctx.id, hasRole(data.roleIds, ownerId) && data.status === 'active');
      if (ctx.id === ctx.actorId && data.status !== 'active') throw new ConflictError('You cannot deactivate your own account');
      if (data.status !== 'active' && ctx.existing.status === 'active') await revokeSessions(ctx.id, false);
    }
    return data;
  },
  async beforeArchive(doc, ctx) {
    if (String(doc._id) === ctx.actorId) throw new ConflictError('You cannot archive your own account');
    const ownerId = await ownerRoleId();
    if (hasRole(doc.roleIds, ownerId) && doc.status === 'active') await assertOwnerRemains(String(doc._id), false);
    await revokeSessions(String(doc._id));
  },
};

/** Admin creates a user. Without a password, a set-password e-mail is sent. */
export async function createUser(input: Plain, ctx: ServiceContext) {
  const { password, ...rest } = input as Plain & { password?: string };
  const passwordHash = await hashPassword(password ?? randomToken(24));
  const user = await createRecord({
    ...userDefinition,
    prepare: async (d, c) => {
      await assertCanAssignRoles(c.actorId, [], (d.roleIds ?? []) as unknown[]);
      return { ...d, passwordHash, passwordChangedAt: password ? new Date() : undefined };
    },
  }, rest, ctx);
  let invitation: { sent: boolean; resetToken?: string } | undefined;
  if (!password) invitation = await issuePasswordReset(String(user.email), 'invite');
  return { user, invitation };
}

/** An administrator sets a user's password; every session of that user is signed out. */
export async function setPassword(id: string, password: string, ctx: ServiceContext) {
  if (id === ctx.actorId) throw new ConflictError('Change your own password from your account, with your current password');
  // Taking over an account is as strong as holding its roles: only someone who could grant them may do it.
  const target = await User.findById(id).select('roleIds').lean();
  await assertCanAssignRoles(ctx.actorId, [], (target?.roleIds ?? []) as unknown[]);
  await User.updateOne({ _id: id }, {
    // Someone else knows it now, so it's replaced at the next sign-in.
    $set: { passwordHash: await hashPassword(password), passwordChangedAt: new Date(), failedLoginCount: 0, mustChangePassword: true },
    $unset: { lockedUntil: 1 },
  });
  await revokeSessions(id);
  await audit({ entity: 'users', entityId: new Types.ObjectId(id), action: 'custom', summary: 'Password set by an administrator; all sessions signed out', actorId: ctx.actorId, requestId: ctx.requestId });
}

/** Sends a fresh invitation (a link to choose a password); earlier links stop working. */
export async function resendInvitation(id: string, ctx: ServiceContext) {
  const user = await User.findById(id).select('email status roleIds').lean();
  await assertCanAssignRoles(ctx.actorId, [], (user?.roleIds ?? []) as unknown[]);
  if (!user?.email) throw new ConflictError('This user has no e-mail address. Set a password for them instead.');
  if (user.status !== 'active') throw new ConflictError('Only active users can be invited');
  return issuePasswordReset(user.email, 'invite');
}

export async function unlockUser(id: string) {
  await User.updateOne({ _id: id }, { $set: { failedLoginCount: 0 }, $unset: { lockedUntil: 1 } });
}
