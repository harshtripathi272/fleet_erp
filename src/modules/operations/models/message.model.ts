import { Schema } from 'mongoose';
import { opsModel } from './model.js';
import { ObjectId, schemaOptions } from '../../../core/masters/schema.js';
import { DESKS } from './funding.model.js';

const buttonSchema = new Schema({
  label: { type: String, required: true },
  tone: { type: String, enum: ['primary', 'danger'] },
  /** A command the button runs, e.g. { type: 'request.decide', id, approve: true }. */
  action: Schema.Types.Mixed,
  /** Asks the driver for a photo of this kind. */
  attach: String,
  /** Where the button leads in the app. */
  nav: Schema.Types.Mixed,
}, { _id: false });

/**
 * One message in a conversation. Threads: a desk ("operations", "finance", "owner"),
 * "driver:<id>" for a driver's WhatsApp, or "customer:<id>". `from` is the system ("bot"),
 * the office ("me") or the driver/customer ("contact").
 */
const messageSchema = new Schema<any>({
  thread: { type: String, required: true },
  from: { type: String, enum: ['bot', 'me', 'contact'], required: true },
  text: { type: String, default: '' },
  title: String,
  rows: { type: [[String]], default: undefined },
  attachment: Schema.Types.Mixed,
  buttons: { type: [buttonSchema], default: undefined },
  resolved: String,
  refId: String,
  at: { type: Date, required: true },
  userId: { type: ObjectId, ref: 'User' },
  /** Outbound WhatsApp delivery through Marichi Talks. */
  delivery: { type: new Schema({ channel: String, to: String, status: String, providerRef: String, error: String }, { _id: false }), default: undefined },
}, { ...schemaOptions, optimisticConcurrency: false });
messageSchema.index({ thread: 1, at: 1 });
messageSchema.index({ refId: 1 });
messageSchema.index({ updatedAt: 1 });

export const Message = opsModel('Message', messageSchema);

/** When a user last read a thread. */
const threadReadSchema = new Schema<any>({
  userId: { type: ObjectId, ref: 'User', required: true },
  thread: { type: String, required: true },
  at: { type: Date, required: true },
}, { timestamps: true, versionKey: false });
threadReadSchema.index({ userId: 1, thread: 1 }, { unique: true });

export const ThreadRead = opsModel('ThreadRead', threadReadSchema);

/** The plain-language activity feed shown on trips and the owner's overview. */
const activitySchema = new Schema<any>({
  at: { type: Date, required: true },
  tripId: { type: ObjectId, ref: 'Trip' },
  desk: { type: String, enum: DESKS, required: true },
  userId: { type: ObjectId, ref: 'User' },
  text: { type: String, required: true },
}, { timestamps: true, versionKey: false });
activitySchema.index({ at: -1 });
activitySchema.index({ tripId: 1, at: 1 });
activitySchema.index({ updatedAt: 1 });

export const Activity = opsModel('Activity', activitySchema);

/** Fallback document numbers when no numbering series is set up, e.g. TRIP/26/0001. */
const counterSchema = new Schema<any>({ _id: String, seq: { type: Number, default: 0 } }, { versionKey: false });
export const OpsCounter = opsModel('OpsCounter', counterSchema);
