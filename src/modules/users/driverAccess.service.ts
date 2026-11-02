import { Types } from 'mongoose';
import { ConflictError, NotFoundError } from '../../core/errors/index.js';
import { hashPassword } from '../../core/security/password.js';
import { Driver } from '../drivers/models/driver.model.js';
import { revokeSessions } from './users.service.js';
import { User } from './user.model.js';

/**
 * A driver's own sign-in for the driver app: a user account linked to the driver record, with no roles.
 * It signs in with the driver's phone number (or an e-mail, if the driver has one) and sees only that
 * driver's work.
 */
export interface DriverAccessInput {
  phone?: string;
  email?: string;
  password?: string;
}

const present = (user: { _id: unknown; phone?: string; email?: string; status: string; lastLoginAt?: Date } | null) => user
  ? { userId: String(user._id), phone: user.phone ?? null, email: user.email ?? null, status: user.status, lastLoginAt: user.lastLoginAt?.toISOString() ?? null }
  : null;

async function driverOr404(driverId: string) {
  const driver = await Driver.findById(driverId).select('name phone whatsapp status').lean();
  if (!driver) throw new NotFoundError('Driver not found');
  return driver;
}

export async function getAccess(driverId: string) {
  await driverOr404(driverId);
  return { access: present(await User.findOne({ driverId }).select('phone email status lastLoginAt').lean()) };
}

/** Gives the driver access, or changes their sign-in: phone, e-mail or a new password. */
export async function setAccess(driverId: string, input: DriverAccessInput, actorId: string) {
  const driver = await driverOr404(driverId);
  if (driver.status !== 'active') throw new ConflictError('Only an active driver can have access to the driver app');
  const existing = await User.findOne({ driverId }).select('_id').lean();
  const phone = input.phone ?? (existing ? undefined : String(driver.whatsapp ?? driver.phone ?? '').replace(/[\s()-]/g, '') || undefined);
  if (!existing && !phone && !input.email) throw new ConflictError('Give a phone number or an e-mail to sign in with');
  if (!existing && !input.password) throw new ConflictError('Set a password for the driver');
  if (phone) {
    const digits = phone.replace(/^\+/, '');
    const clash = await User.exists({ phone: { $in: [digits, `+${digits}`] }, _id: { $ne: existing?._id } });
    if (clash) throw new ConflictError('Another account already signs in with this phone number', { fields: ['phone'] });
  }
  if (input.email && (await User.exists({ email: input.email, _id: { $ne: existing?._id } }))) {
    throw new ConflictError('Another account already uses this e-mail', { fields: ['email'] });
  }
  const set: Record<string, unknown> = { status: 'active', updatedBy: new Types.ObjectId(actorId) };
  if (phone) set.phone = phone;
  if (input.email) set.email = input.email;
  if (input.password) Object.assign(set, { passwordHash: await hashPassword(input.password), passwordChangedAt: new Date(), failedLoginCount: 0 });
  if (existing) {
    await User.updateOne({ _id: existing._id }, { $set: set, $inc: { version: 1 }, ...(input.password ? { $unset: { lockedUntil: 1 } } : {}) });
    if (input.password) await revokeSessions(String(existing._id));
  } else {
    await User.create({ name: driver.name, driverId: new Types.ObjectId(driverId), roleIds: [], ...set, createdBy: new Types.ObjectId(actorId) } as Record<string, unknown>);
  }
  return getAccess(driverId);
}

/** Takes the driver's access away and signs them out everywhere. */
export async function removeAccess(driverId: string, actorId: string) {
  await driverOr404(driverId);
  const user = await User.findOne({ driverId }).select('_id').lean();
  if (!user) return { access: null };
  await User.updateOne({ _id: user._id }, { $set: { status: 'inactive', updatedBy: new Types.ObjectId(actorId) }, $inc: { version: 1 } });
  await revokeSessions(String(user._id));
  return getAccess(driverId);
}
