import { model, type Types } from 'mongoose';
import { ObjectId, masterSchema } from '../../core/masters/schema.js';

export interface UserRecord {
  _id: Types.ObjectId;
  name: string;
  email: string;
  phone?: string;
  passwordHash: string;
  roleIds: Types.ObjectId[];
  status: 'active' | 'inactive' | 'archived';
  tokenVersion: number;
  failedLoginCount: number;
  lockedUntil?: Date;
  lastLoginAt?: Date;
  passwordChangedAt?: Date;
  version: number;
}

const userSchema = masterSchema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, trim: true, lowercase: true },
  phone: String,
  passwordHash: { type: String, required: true, select: false },
  roleIds: { type: [{ type: ObjectId, ref: 'Role' }], default: [] },
  tokenVersion: { type: Number, default: 0 },
  failedLoginCount: { type: Number, default: 0 },
  lockedUntil: Date,
  lastLoginAt: Date,
  passwordChangedAt: Date,
});
userSchema.index({ email: 1 }, { unique: true });

export const User = model<UserRecord>('User', userSchema);
