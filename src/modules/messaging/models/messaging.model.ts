import { Schema } from 'mongoose';
import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, masterSchema, masterModel } from '../../../core/masters/schema.js';

export const MESSAGE_CHANNELS = ['whatsapp', 'sms', 'email'] as const;
export const AUDIENCES = ['driver', 'operations', 'finance', 'owner', 'customer', 'any'] as const;
export const BUTTON_ACTIONS = ['approve', 'reject', 'send_photo', 'open_link', 'reply'] as const;
export const EVENTS = [
  'trip.created', 'trip.dispatched', 'trip.arrived_loading', 'trip.loaded', 'trip.arrived_offloading', 'trip.delivered', 'trip.closed',
  'fund_request.created', 'fund_request.approved', 'fund_request.rejected', 'fund_request.paid',
  'expense.submitted', 'expense.approved', 'expense.rejected',
  'document.expiring', 'document.expired', 'settlement.posted', 'nomination.sent', 'user.invited', 'password.reset',
  'service.due',
] as const;
/** Each event as people say it: what has just happened. */
export const EVENT_NAMES: Record<(typeof EVENTS)[number], string> = {
  'trip.created': 'A trip is created', 'trip.dispatched': 'A trip leaves', 'trip.arrived_loading': 'A truck reaches loading',
  'service.due': 'A service is due on a truck',
  'trip.loaded': 'A truck is loaded', 'trip.arrived_offloading': 'A truck reaches offloading', 'trip.delivered': 'A load is delivered',
  'trip.closed': 'A trip is closed', 'fund_request.created': 'Fuel or cash is requested', 'fund_request.approved': 'A request is approved',
  'fund_request.rejected': 'A request is rejected', 'fund_request.paid': 'A request is paid out', 'expense.submitted': 'An expense is sent in',
  'expense.approved': 'An expense is approved', 'expense.rejected': 'An expense is rejected', 'document.expiring': 'A document is about to expire',
  'document.expired': 'A document has expired', 'settlement.posted': 'A driver is settled', 'nomination.sent': 'A nomination goes to the customer',
  'user.invited': 'Someone is invited', 'password.reset': 'A password reset is asked for',
};
export const CHANNEL_NAMES: Record<(typeof MESSAGE_CHANNELS)[number], string> = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'E-mail' };
/** Placeholders a template may use, written {{name}}. */
export const VARIABLES = [
  'company.name', 'user.name', 'driver.name', 'driver.phone', 'vehicle.registration', 'trailer.registration', 'trip.number',
  'route.name', 'place.name', 'customer.name', 'amount', 'currency', 'document.name', 'document.number', 'document.expiryDate',
  'reason', 'link', 'date',
] as const;

/** A WhatsApp or SMS message sent through Marichi Talks, or an e-mail sent over SMTP. */
const messageTemplateSchema = masterSchema({
  ...codeNameFields,
  channel: { type: String, enum: MESSAGE_CHANNELS, required: true },
  event: { type: String, enum: EVENTS, required: true },
  audience: { type: String, enum: AUDIENCES, default: 'any' },
  language: { type: String, default: 'en' },
  subject: String,
  body: { type: String, required: true },
  buttons: { type: [{ _id: false, label: String, action: { type: String, enum: BUTTON_ACTIONS } }], default: undefined },
  providerTemplateId: String,
  /** Created by the installation's default set (#43); the company may edit or archive it like any other. */
  isDefault: { type: Boolean, default: undefined },
});
uniqueIndex(messageTemplateSchema, { code: 1 });
messageTemplateSchema.index({ event: 1, channel: 1, audience: 1, language: 1 }, { unique: true, partialFilterExpression: { status: 'active' } });
export const MessageTemplate = masterModel('MessageTemplate', messageTemplateSchema);

export const RECIPIENT_KINDS = ['role', 'user', 'driver', 'party_contact'] as const;
const recipientSchema = new Schema({
  kind: { type: String, enum: RECIPIENT_KINDS, required: true },
  roleId: { type: ObjectId, ref: 'Role' },
  userId: { type: ObjectId, ref: 'User' },
}, { _id: false });

const notificationRuleSchema = masterSchema({
  ...codeNameFields,
  event: { type: String, enum: EVENTS, required: true },
  recipients: { type: [recipientSchema], required: true },
  templates: { type: [{ _id: false, channel: { type: String, enum: [...MESSAGE_CHANNELS, 'app'] }, templateId: { type: ObjectId, ref: 'MessageTemplate' } }], required: true },
  delayMinutes: { type: Number, min: 0, max: 10080, default: 0 },
  repeatEveryMinutes: { type: Number, min: 15, max: 10080 },
  maxRepeats: { type: Number, min: 0, max: 10, default: 0 },
  /** Created by the installation's default set (#43); the company may edit or archive it like any other. */
  isDefault: { type: Boolean, default: undefined },
});
uniqueIndex(notificationRuleSchema, { code: 1 });
export const NotificationRule = masterModel('NotificationRule', notificationRuleSchema);

export const PRINT_DOCUMENTS = ['trip_sheet', 'driver_statement', 'invoice', 'nomination_slip', 'delivery_note', 'fund_request'] as const;
const printLayoutSchema = masterSchema({
  ...codeNameFields,
  document: { type: String, enum: PRINT_DOCUMENTS, required: true },
  paperSize: { type: String, enum: ['A4', 'A5', 'Letter'], default: 'A4' },
  orientation: { type: String, enum: ['portrait', 'landscape'], default: 'portrait' },
  showLogo: { type: Boolean, default: true },
  sections: { type: [{ _id: false, key: String, label: String, visible: Boolean, order: Number }], default: [] },
  signatureLines: { type: [String], default: undefined },
  footerText: String,
  isDefault: { type: Boolean, default: false },
});
uniqueIndex(printLayoutSchema, { code: 1 });
printLayoutSchema.index({ document: 1 }, { unique: true, partialFilterExpression: { isDefault: true, status: 'active' } });
export const PrintLayout = masterModel('PrintLayout', printLayoutSchema);
