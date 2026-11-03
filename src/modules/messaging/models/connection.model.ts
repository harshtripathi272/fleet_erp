import { Schema, model, type Types } from 'mongoose';
import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { masterSchema, masterModel } from '../../../core/masters/schema.js';
import { smsAdapters } from '../../../core/sms/index.js';

/** Providers a connection can use, per channel. SMS providers come from the adapters registered in core/sms. */
export const EMAIL_PROVIDERS = ['smtp'] as const;
/** Until Marichi Talks is connected (#10), WhatsApp goes to the in-app simulator. */
export const WHATSAPP_PROVIDERS = ['simulator'] as const;
export const providersFor = (channel: string): string[] =>
  channel === 'email' ? [...EMAIL_PROVIDERS] : channel === 'whatsapp' ? [...WHATSAPP_PROVIDERS] : smsAdapters().map((a) => a.key);
export const ALL_PROVIDERS = () => [...new Set([...EMAIL_PROVIDERS, ...WHATSAPP_PROVIDERS, ...smsAdapters().map((a) => a.key)])];

/**
 * Names a connection may give for the environment variable that holds its password or key. Limited so
 * a connection can never point at the server's own secrets (JWT_SECRET, MONGODB_URI, ...) and send
 * them to a server of its choosing.
 */
export const SECRET_ENV = /^(SMTP_PASS|MESSAGING_[A-Z0-9_]{1,50})$/;

/**
 * How this installation sends on one channel: an SMTP server for e-mail, an SMS provider, or WhatsApp.
 * Passwords and keys are never stored here: `secretEnv` names the environment variable (or Secret
 * Manager secret mounted as one) that holds it.
 */
const lastTestSchema = new Schema({ at: Date, ok: Boolean, to: String, error: String }, { _id: false });
const lastErrorSchema = new Schema({ at: Date, message: String }, { _id: false });
const connectionSchema = masterSchema({
  ...codeNameFields,
  channel: { type: String, enum: ['email', 'sms', 'whatsapp'], required: true },
  provider: { type: String, required: true },
  enabled: { type: Boolean, default: false },
  /** E-mail: the SMTP server. */
  host: String,
  port: Number,
  secure: Boolean,
  /** E-mail: SMTP user. SMS: the provider's account or username. Not secret. */
  user: String,
  /** E-mail: the From address, e.g. "Marichi Fleet <fleet@company.com>". */
  from: String,
  /** SMS: the sender name or number the provider shows. */
  senderId: String,
  secretEnv: String,
  /** Kept by the system: the last test and the last failure, for the settings screen. */
  lastTest: { type: lastTestSchema, default: undefined },
  lastError: { type: lastErrorSchema, default: undefined },
  lastSentAt: Date,
});
uniqueIndex(connectionSchema, { code: 1 });
// One switched-on connection per channel, so the dispatcher never has to choose.
connectionSchema.index({ channel: 1 }, { unique: true, name: 'one_enabled_per_channel', partialFilterExpression: { enabled: true, status: 'active' } });
export const MessageConnection = masterModel('MessageConnection', connectionSchema);

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
  sentAt: Date,
  connectionId: { type: Schema.Types.ObjectId, ref: 'MessageConnection' },
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
