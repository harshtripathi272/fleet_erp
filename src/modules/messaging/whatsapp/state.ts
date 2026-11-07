import { Schema, model } from 'mongoose';
import type { WhatsAppDelivery } from '../../../core/connections/index.js';
import { CARRIER, type WaUse, asVariable, waTemplate } from './templates.js';

/**
 * What the app knows about WhatsApp beyond the message itself (#112): when each number last wrote (the
 * 24-hour window), and each template's standing at Meta, per connection.
 */
const contactSchema = new Schema({
  phone: { type: String, required: true },
  lastInboundAt: { type: Date, required: true },
}, { versionKey: false });
contactSchema.index({ phone: 1 }, { unique: true });
export const WaContact = model('WaContact', contactSchema);

export const TEMPLATE_STATUSES = ['not_submitted', 'pending', 'approved', 'rejected', 'paused', 'disabled'] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];
const templateStateSchema = new Schema({
  connectionId: { type: Schema.Types.ObjectId, ref: 'Connection', required: true },
  name: { type: String, required: true },
  language: { type: String, required: true },
  status: { type: String, enum: TEMPLATE_STATUSES, default: 'not_submitted' },
  reason: String,
  metaId: String,
  submittedAt: Date,
  checkedAt: Date,
}, { versionKey: false });
templateStateSchema.index({ connectionId: 1, name: 1, language: 1 }, { unique: true });
export const WaTemplateState = model('WaTemplateState', templateStateSchema);

const WINDOW_MS = 24 * 3600_000;
export const digitsOf = (phone: string) => phone.replace(/[^\d]/g, '');

/** A message from this number opens its 24 hours again. */
export async function noteInbound(phone: string, at = new Date()) {
  await WaContact.updateOne({ phone: digitsOf(phone) }, { $max: { lastInboundAt: at } }, { upsert: true });
}

async function approved(connectionId: unknown, name: string) {
  return Boolean(await WaTemplateState.exists({ connectionId, name, status: 'approved' } as Record<string, unknown>));
}

/**
 * How one message goes out. Within 24 hours of the person's last message: as written (with its buttons).
 * Otherwise: its own approved template, else the carrier template, else as written, which WhatsApp then
 * refuses; the outbox then says which template to get approved.
 */
export async function planDelivery(input: { connectionId: unknown; to: string; text: string; buttons?: string[]; use?: WaUse; company: string }): Promise<WhatsAppDelivery> {
  const contact = await WaContact.findOne({ phone: digitsOf(input.to) }).select('lastInboundAt').lean<{ lastInboundAt?: Date }>();
  const open = Boolean(contact?.lastInboundAt && Date.now() - contact.lastInboundAt.getTime() < WINDOW_MS);
  const own = input.use && waTemplate(input.use.template);
  const asTemplate = (name: string, body: string[]) => {
    const t = waTemplate(name)!;
    return { name: t.name, language: t.language, header: [asVariable(input.company)], body: body.map(asVariable), buttons: t.buttons?.length ?? 0 };
  };
  const needed = own?.name ?? CARRIER;
  if (open) return { buttons: input.buttons, needed };
  if (own && (await approved(input.connectionId, own.name))) return { template: asTemplate(own.name, input.use!.values), needed };
  if (await approved(input.connectionId, CARRIER)) return { template: asTemplate(CARRIER, [input.text]), needed };
  return { buttons: input.buttons, needed };
}
