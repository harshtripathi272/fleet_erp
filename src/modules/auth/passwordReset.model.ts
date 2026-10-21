import { Schema, model, type Types } from 'mongoose';

export interface PasswordResetRecord {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  tokenHash: string;
  purpose: 'reset' | 'invite';
  expiresAt: Date;
  usedAt: Date | null;
}

/** Single-use password reset or invitation token, stored as a SHA-256 hash. */
const passwordResetSchema = new Schema<PasswordResetRecord>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tokenHash: { type: String, required: true },
  purpose: { type: String, enum: ['reset', 'invite'], default: 'reset' },
  expiresAt: { type: Date, required: true },
  usedAt: { type: Date, default: null },
}, { timestamps: true, versionKey: false, strict: 'throw' });

passwordResetSchema.index({ tokenHash: 1 }, { unique: true });
passwordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 3600 });

export const PasswordReset = model<PasswordResetRecord>('PasswordReset', passwordResetSchema);
