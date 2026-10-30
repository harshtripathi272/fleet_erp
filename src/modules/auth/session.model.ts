import { Schema, model, type Types } from 'mongoose';

export interface SessionRecord {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason?: string;
  userAgent?: string;
  ip?: string;
  lastUsedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** One signed-in device. The refresh token is stored only as a SHA-256 hash. */
const sessionSchema = new Schema<SessionRecord>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  familyId: { type: String, required: true, index: true },
  tokenHash: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
  revokedReason: String,
  userAgent: String,
  ip: String,
  lastUsedAt: Date,
}, { timestamps: true, versionKey: false, strict: 'throw' });

sessionSchema.index({ tokenHash: 1 }, { unique: true });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });

export const Session = model<SessionRecord>('Session', sessionSchema);
