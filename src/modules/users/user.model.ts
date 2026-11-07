import { model, type Types } from 'mongoose';
import { ObjectId, masterSchema } from '../../core/masters/schema.js';

export interface UserRecord {
  _id: Types.ObjectId;
  name: string;
  /** Optional for driver accounts, which sign in with their phone number. */
  email?: string;
  phone?: string;
  /** Set when this account belongs to a driver: it opens the driver app and sees only that driver's work. */
  driverId?: Types.ObjectId;
  passwordHash: string;
  roleIds: Types.ObjectId[];
  status: 'active' | 'inactive' | 'archived';
  tokenVersion: number;
  failedLoginCount: number;
  lockedUntil?: Date;
  lastLoginAt?: Date;
  passwordChangedAt?: Date;
  /** The password came from someone else (a settings file, an administrator): it must be replaced at the next sign-in. */
  mustChangePassword?: boolean;
  version: number;
}

const userSchema = masterSchema({
  name: { type: String, required: true, trim: true },
  email: { type: String, trim: true, lowercase: true },
  phone: String,
  driverId: { type: ObjectId, ref: 'Driver' },
  passwordHash: { type: String, required: true, select: false },
  roleIds: { type: [{ type: ObjectId, ref: 'Role' }], default: [] },
  tokenVersion: { type: Number, default: 0 },
  failedLoginCount: { type: Number, default: 0 },
  lockedUntil: Date,
  lastLoginAt: Date,
  passwordChangedAt: Date,
  mustChangePassword: { type: Boolean, default: false },
});
userSchema.index({ email: 1 }, { unique: true, name: 'email_unique', partialFilterExpression: { email: { $type: 'string' } } });
userSchema.index({ driverId: 1 }, { unique: true, name: 'driver_unique', partialFilterExpression: { driverId: { $type: 'objectId' } } });
userSchema.index({ phone: 1 });

export const User = model<UserRecord>('User', userSchema);

/** Databases created before e-mail became optional have a unique index that counts a missing e-mail as a value. */
export async function migrateUserIndexes() {
  const indexes = await User.collection.indexes().catch(() => []);
  if (indexes.some((i) => i.name === 'email_1')) await User.collection.dropIndex('email_1');
}
