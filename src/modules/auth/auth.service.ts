import { Types } from 'mongoose';
type Id = Types.ObjectId | string;
import { env } from '../../config/env.js';
import { ConflictError, ForbiddenError, TooManyRequestsError, UnauthorizedError, ValidationError } from '../../core/errors/index.js';
import { logger } from '../../core/logger/index.js';
import { sendMail } from '../../core/mail/mailer.js';
import { audit } from '../../core/masters/audit.js';
import { serialize } from '../../core/masters/service.js';
import type { Plain } from '../../core/masters/types.js';
import { signAccessToken } from '../../core/security/jwt.js';
import { dummyPasswordHash, hashPassword, verifyPassword } from '../../core/security/password.js';
import { randomToken, sha256 } from '../../core/security/tokens.js';
import { Company } from '../company/company.model.js';
import { Role } from '../roles/role.model.js';
import { User } from '../users/user.model.js';
import { userDefinition } from '../users/users.service.js';
import type { LoginInput, RegisterInput } from './auth.schema.js';
import { PasswordReset } from './passwordReset.model.js';
import { Session } from './session.model.js';
import { SystemState } from './systemState.model.js';

export interface ClientInfo { ip?: string; userAgent?: string; }
const INVALID_LOGIN = 'Invalid e-mail or password';

const presentUser = (user: Plain) => serialize(userDefinition, user, { canSeeSensitive: true });

async function rolesOf(roleIds: Id[]) {
  const roles = await Role.find({ _id: { $in: roleIds }, status: 'active' }).lean();
  return roles.map((r) => ({ id: String(r._id), key: r.key, name: r.name, permissions: r.permissions }));
}

async function startSession(user: { _id: Id; tokenVersion?: number }, client: ClientInfo, familyId = randomToken(16)) {
  const refreshToken = randomToken(32);
  const session = await Session.create({
    userId: user._id,
    familyId,
    tokenHash: sha256(refreshToken),
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86400000),
    userAgent: client.userAgent?.slice(0, 300),
    ip: client.ip,
    lastUsedAt: new Date(),
  });
  const access = signAccessToken({ sub: String(user._id), sid: String(session._id), tv: user.tokenVersion ?? 0 });
  return { accessToken: access.token, accessTokenExpiresAt: access.expiresAt, refreshToken, refreshTokenExpiresAt: session.expiresAt };
}

async function sessionResponse(userId: Id, client: ClientInfo, familyId?: string) {
  const user = await User.findById(userId).lean();
  if (!user) throw new UnauthorizedError();
  const tokens = await startSession(user, client, familyId);
  return { ...tokens, user: presentUser(user as unknown as Plain), roles: await rolesOf(user.roleIds ?? []) };
}

/** Atomically claims the first-owner slot; true only for the first caller. */
async function claimFirstOwner(): Promise<boolean> {
  try {
    const result = await SystemState.updateOne({ key: 'owner-claimed' }, { $setOnInsert: { value: new Date() } }, { upsert: true });
    return result.upsertedCount === 1;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return false;
    throw err;
  }
}

export async function register(input: RegisterInput, client: ClientInfo) {
  if (await User.exists({ email: input.email })) throw new ConflictError('An account with this e-mail already exists', { fields: ['email'] });
  // With OWNER_EMAIL set, the first Owner is created at start-up (ensureFirstOwner), never by signing up.
  const first = !env.OWNER_EMAIL && await claimFirstOwner();
  if (!first) {
    // Off unless the company turns it on: a sign-up on a public address would otherwise get read access.
    const company = await Company.findOne().lean<{ allowSelfRegistration?: boolean }>();
    if (company?.allowSelfRegistration !== true) throw new ForbiddenError('Self sign-up is turned off. Ask an administrator for an invitation.');
  }
  const role = await Role.findOne({ key: first ? 'owner' : 'viewer' }).select('_id').lean();
  if (!role) throw new ConflictError('System roles are missing. Restart the server to recreate them.');
  try {
    const user = await User.create({
      name: input.name, email: input.email, passwordHash: await hashPassword(input.password),
      roleIds: [role._id], passwordChangedAt: new Date(),
    });
    await audit({ entity: 'users', entityId: user._id, action: 'create', summary: first ? 'First account; granted owner role' : 'Self sign-up', actorId: String(user._id) });
    logger.info({ userId: String(user._id), owner: first }, 'Account registered');
    return { ...(await sessionResponse(user._id, client)), firstOwner: first };
  } catch (err) {
    if (first) await SystemState.deleteOne({ key: 'owner-claimed' });
    if ((err as { code?: number }).code === 11000) throw new ConflictError('An account with this e-mail already exists', { fields: ['email'] });
    throw err;
  }
}

/**
 * Creates the company's first Owner for `OWNER_EMAIL` and e-mails them a link to choose a password, once,
 * on an installation nobody has claimed yet. Proving the address by that link is what makes the account
 * theirs, so a stranger who reaches a new installation first cannot take it over by signing up.
 * Safe to call from every instance at start-up: only one claims the slot.
 */
export async function ensureFirstOwner(emailAddress = env.OWNER_EMAIL): Promise<{ created: boolean; sent?: boolean }> {
  if (!emailAddress) return { created: false };
  if (!(await claimFirstOwner())) return { created: false };
  try {
    const role = await Role.findOne({ key: 'owner' }).select('_id').lean();
    if (!role) throw new Error('System roles are missing');
    const existing = await User.findOne({ email: emailAddress }).select('_id').lean();
    if (existing) {
      await User.updateOne({ _id: existing._id }, { $addToSet: { roleIds: role._id }, $inc: { version: 1 } });
      await audit({ entity: 'users', entityId: existing._id, action: 'update', summary: 'Granted owner role from OWNER_EMAIL' });
      logger.info({ userId: String(existing._id) }, 'First Owner granted to the existing account for OWNER_EMAIL');
      return { created: false };
    }
    const user = await User.create({
      name: emailAddress.split('@')[0]!.slice(0, 100) || 'Owner', email: emailAddress,
      passwordHash: await hashPassword(randomToken(24)), roleIds: [role._id],
    });
    await audit({ entity: 'users', entityId: user._id, action: 'create', summary: 'First Owner created from OWNER_EMAIL; set-password e-mail sent' });
    const { sent } = await issuePasswordReset(emailAddress, 'invite');
    // If the e-mail did not go, "Forgot password" on the same address sends a new link.
    logger.info({ userId: String(user._id), sent }, 'First Owner account created');
    return { created: true, sent };
  } catch (err) {
    await SystemState.deleteOne({ key: 'owner-claimed' });
    throw err;
  }
}

/** The account for an e-mail, or for a phone number held by exactly one account. */
async function findForLogin(input: LoginInput) {
  if (input.email) return User.findOne({ email: input.email }).select('+passwordHash').lean();
  const digits = input.phone!.replace(/^\+/, '');
  const matches = await User.find({ phone: { $in: [digits, `+${digits}`] } }).select('+passwordHash').limit(2).lean();
  return matches.length === 1 ? matches[0]! : null;
}

export async function login(input: LoginInput, client: ClientInfo) {
  const user = await findForLogin(input);
  if (!user) {
    await verifyPassword(input.password, await dummyPasswordHash());
    throw new UnauthorizedError(INVALID_LOGIN);
  }
  const locked = (until: Date | undefined) => new TooManyRequestsError('Too many failed sign-ins. Try again later or reset your password.', { lockedUntil: until });
  if (user.lockedUntil && user.lockedUntil > new Date()) throw locked(user.lockedUntil);
  // Count the attempt before checking the password, in one atomic step, so sign-ins sent in parallel
  // cannot all read the same failure count: at most LOGIN_MAX_FAILURES of them are ever checked.
  const now = new Date();
  const attempt = await User.findOneAndUpdate(
    { _id: user._id, $or: [{ lockedUntil: { $exists: false } }, { lockedUntil: null }, { lockedUntil: { $lte: now } }] },
    { $inc: { failedLoginCount: 1 } },
    { returnDocument: 'after', projection: { failedLoginCount: 1, lockedUntil: 1 } },
  ).lean();
  if (!attempt) throw locked((await User.findById(user._id).select('lockedUntil').lean())?.lockedUntil);
  const lockAccount = async () => {
    const until = new Date(Date.now() + env.LOGIN_LOCK_MINUTES * 60000);
    await User.updateOne({ _id: user._id }, { $set: { failedLoginCount: 0, lockedUntil: until } });
    logger.warn({ userId: String(user._id) }, 'Account locked after failed sign-ins');
    return until;
  };
  if (attempt.failedLoginCount > env.LOGIN_MAX_FAILURES) throw locked(await lockAccount());
  if (!(await verifyPassword(input.password, user.passwordHash))) {
    if (attempt.failedLoginCount >= env.LOGIN_MAX_FAILURES) await lockAccount();
    throw new UnauthorizedError(INVALID_LOGIN);
  }
  if (user.status !== 'active') {
    await User.updateOne({ _id: user._id }, { $set: { failedLoginCount: 0 } });
    throw new ForbiddenError('This account is deactivated. Contact an administrator.');
  }
  await User.updateOne({ _id: user._id }, { $set: { failedLoginCount: 0, lastLoginAt: new Date() }, $unset: { lockedUntil: 1 } });
  return sessionResponse(user._id, client);
}

/** Rotates the refresh token. Re-using an already rotated token signs out that whole device chain. */
export async function refresh(refreshToken: string, client: ClientInfo) {
  const session = await Session.findOne({ tokenHash: sha256(refreshToken) }).lean();
  if (!session) throw new UnauthorizedError('Session expired or invalid. Sign in again.');
  if (session.revokedAt) {
    if (session.revokedReason === 'rotated') {
      await Session.updateMany({ familyId: session.familyId, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: 'reuse-detected' } });
      logger.warn({ userId: String(session.userId) }, 'Refresh token reuse detected; session family revoked');
    }
    throw new UnauthorizedError('Session expired or invalid. Sign in again.');
  }
  if (session.expiresAt <= new Date()) throw new UnauthorizedError('Session expired. Sign in again.');
  const user = await User.findById(session.userId).select('status').lean();
  if (!user || user.status !== 'active') throw new UnauthorizedError('Session expired or invalid. Sign in again.');
  const claimed = await Session.updateOne({ _id: session._id, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: 'rotated' } });
  if (!claimed.modifiedCount) throw new UnauthorizedError('Session expired or invalid. Sign in again.');
  return sessionResponse(session.userId, client, session.familyId);
}

export async function logout(sessionId: string) {
  await Session.updateOne({ _id: sessionId, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: 'logout' } });
}

export async function logoutAll(userId: string) {
  await Session.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: 'logout-all' } });
  await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
}

export async function me(userId: string) {
  const user = await User.findById(userId).lean();
  if (!user) throw new UnauthorizedError();
  return { user: presentUser(user as unknown as Plain), roles: await rolesOf(user.roleIds ?? []) };
}

export async function updateMe(userId: string, changes: { name?: string; phone?: string | null }) {
  const update: Plain = {};
  const unset: Plain = {};
  if (changes.name !== undefined) update.name = changes.name;
  if (changes.phone === null) unset.phone = 1;
  else if (changes.phone !== undefined) update.phone = changes.phone;
  await User.updateOne({ _id: userId }, { $set: { ...update, updatedBy: new Types.ObjectId(userId) }, ...(Object.keys(unset).length ? { $unset: unset } : {}), $inc: { version: 1 } });
  await audit({ entity: 'users', entityId: userId, action: 'update', summary: 'Updated own profile', actorId: userId, changes: Object.keys({ ...update, ...unset }).map((path) => ({ path, from: null, to: (update[path] ?? null) })) });
  return me(userId);
}

export async function changePassword(userId: string, current: string, next: string, client: ClientInfo) {
  const user = await User.findById(userId).select('+passwordHash').lean();
  if (!user || !(await verifyPassword(current, user.passwordHash))) throw new ValidationError('Current password is incorrect', { currentPassword: ['Incorrect'] });
  if (current === next) throw new ValidationError('Choose a password different from the current one', { newPassword: ['Same as current'] });
  await User.updateOne({ _id: userId }, { $set: { passwordHash: await hashPassword(next), passwordChangedAt: new Date() }, $inc: { tokenVersion: 1 } });
  await Session.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: 'password-changed' } });
  await audit({ entity: 'users', entityId: userId, action: 'custom', summary: 'Password changed; other sessions signed out', actorId: userId });
  return sessionResponse(userId, client);
}

/** Creates a single-use token and e-mails the link. */
export async function issuePasswordReset(emailAddress: string, purpose: 'reset' | 'invite' = 'reset') {
  const user = await User.findOne({ email: emailAddress, status: 'active' }).select('_id name email').lean();
  if (!user) return { sent: false };
  await PasswordReset.updateMany({ userId: user._id, usedAt: null }, { $set: { usedAt: new Date() } });
  const token = randomToken(32);
  await PasswordReset.create({
    userId: user._id, tokenHash: sha256(token), purpose,
    expiresAt: new Date(Date.now() + (purpose === 'invite' ? 72 * 60 : env.PASSWORD_RESET_TTL_MINUTES) * 60000),
  });
  const link = `${env.APP_URL}/console/#reset=${token}`;
  const sent = await sendMail({
    to: user.email!,
    subject: purpose === 'invite' ? 'You have been invited to Marichi Fleet' : 'Reset your Marichi Fleet password',
    text: purpose === 'invite'
      ? `Hello ${user.name},\n\nAn account was created for you. Set your password here (valid for 72 hours):\n${link}\n`
      : `Hello ${user.name},\n\nUse this link to choose a new password. It is valid for ${env.PASSWORD_RESET_TTL_MINUTES} minutes and can be used once:\n${link}\n\nIf you did not ask for this, ignore this e-mail.`,
  });
  return { sent, ...(env.EXPOSE_RESET_TOKEN ? { resetToken: token } : {}) };
}

export async function forgotPassword(emailAddress: string) {
  const result = await issuePasswordReset(emailAddress, 'reset');
  return env.EXPOSE_RESET_TOKEN && result.resetToken ? { resetToken: result.resetToken } : {};
}

export async function resetPassword(token: string, password: string) {
  const reset = await PasswordReset.findOneAndUpdate(
    { tokenHash: sha256(token), usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
  ).lean();
  if (!reset) throw new ValidationError('This reset link is invalid, expired or already used', { token: ['Invalid or expired'] });
  await User.updateOne({ _id: reset.userId }, {
    $set: { passwordHash: await hashPassword(password), passwordChangedAt: new Date(), failedLoginCount: 0 },
    $unset: { lockedUntil: 1 }, $inc: { tokenVersion: 1 },
  });
  await Session.updateMany({ userId: reset.userId, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: 'password-reset' } });
  await audit({ entity: 'users', entityId: reset.userId, action: 'custom', summary: reset.purpose === 'invite' ? 'Password set from invitation' : 'Password reset; all sessions signed out' });
}

export async function listSessions(userId: string, currentSessionId: string) {
  const sessions = await Session.find({ userId, revokedAt: null, expiresAt: { $gt: new Date() } }).sort({ lastUsedAt: -1 }).limit(50).lean();
  return sessions.map((s) => ({ id: String(s._id), createdAt: s.createdAt, lastUsedAt: s.lastUsedAt, expiresAt: s.expiresAt, userAgent: s.userAgent, ip: s.ip, current: String(s._id) === currentSessionId }));
}
