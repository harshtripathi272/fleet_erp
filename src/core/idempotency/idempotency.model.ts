import { model, Schema, type Types } from 'mongoose';
import { ObjectId } from '../masters/schema.js';

/** How long a key is remembered. A phone that was offline longer than this sends its item as new. */
export const KEY_TTL_DAYS = 7;

export interface IdempotencyRecord {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  key: string;
  /** `POST /api/v1/files`: a key belongs to one route. */
  route: string;
  state: 'running' | 'done';
  status?: number;
  body?: unknown;
  at: Date;
}

/** One request per (person, key): the first runs, a repeat gets the stored reply. */
const idempotencySchema = new Schema<IdempotencyRecord>({
  userId: { type: ObjectId, ref: 'User', required: true },
  key: { type: String, required: true },
  route: { type: String, required: true },
  state: { type: String, enum: ['running', 'done'], required: true },
  status: Number,
  body: Schema.Types.Mixed,
  at: { type: Date, required: true },
}, { collection: 'idempotency_keys', versionKey: false });
idempotencySchema.index({ userId: 1, key: 1 }, { unique: true });
idempotencySchema.index({ at: 1 }, { expireAfterSeconds: KEY_TTL_DAYS * 86400 });

export const IdempotencyKey = model<IdempotencyRecord>('IdempotencyKey', idempotencySchema);
