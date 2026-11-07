import { Schema, model, type Types } from 'mongoose';

// Connections themselves moved to src/modules/connections (#59); the outbox stays with messaging.
export const OUTBOX_STATUSES = ['queued', 'sending', 'sent', 'failed', 'simulated', 'skipped'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export interface OutboundRecord {
  _id: Types.ObjectId;
  event: string;
  channel: 'email' | 'sms' | 'whatsapp';
  to?: string;
  toName?: string;
  subject?: string;
  body: string;
  attachments?: Array<{ fileId?: Types.ObjectId; name: string }>;
  status: OutboxStatus;
  /** Why it was simulated or skipped, or the last error. */
  note?: string;
  attempts: number;
  nextAttemptAt?: Date;
  leaseUntil?: Date;
  providerRef?: string;
  /** WhatsApp only (#112): the template that carries it after the 24 hours, and its values. */
  whatsapp?: { template: string; values: string[] };
  sentAt?: Date;
  connectionId?: Types.ObjectId;
  ruleId?: Types.ObjectId;
  templateId?: Types.ObjectId;
  /** The record the message is about, e.g. { kind: 'trips', id }. */
  ref?: { kind: string; id: string };
  sensitive?: boolean;
  resentFromId?: Types.ObjectId;
  createdBy?: Types.ObjectId;
  at: Date;
  updatedAt: Date;
}

/** Every message the system sends or would have sent: one record per recipient and channel. */
const outboundSchema = new Schema<OutboundRecord>({
  event: { type: String, required: true },
  channel: { type: String, enum: ['email', 'sms', 'whatsapp'], required: true },
  to: String,
  toName: String,
  subject: String,
  body: { type: String, required: true },
  attachments: { type: [new Schema({ fileId: Schema.Types.ObjectId, name: String }, { _id: false })], default: undefined },
  status: { type: String, enum: OUTBOX_STATUSES, required: true },
  note: String,
  attempts: { type: Number, default: 0 },
  nextAttemptAt: Date,
  leaseUntil: Date,
  providerRef: String,
  whatsapp: { type: new Schema({ template: String, values: [String] }, { _id: false }), default: undefined },
  sentAt: Date,
  connectionId: { type: Schema.Types.ObjectId, ref: 'Connection' },
  ruleId: { type: Schema.Types.ObjectId, ref: 'NotificationRule' },
  templateId: { type: Schema.Types.ObjectId, ref: 'MessageTemplate' },
  ref: { type: new Schema({ kind: String, id: String }, { _id: false }), default: undefined },
  sensitive: Boolean,
  resentFromId: { type: Schema.Types.ObjectId, ref: 'OutboundMessage' },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  at: { type: Date, required: true },
}, { timestamps: { createdAt: false, updatedAt: true }, versionKey: false, strict: 'throw', collection: 'outbox' });
// The worker's queue, the screen's newest-first list, and its filters.
outboundSchema.index({ status: 1, nextAttemptAt: 1 });
outboundSchema.index({ at: -1 });
outboundSchema.index({ channel: 1, at: -1 });
outboundSchema.index({ event: 1, at: -1 });
export const OutboundMessage = model<OutboundRecord>('OutboundMessage', outboundSchema);
