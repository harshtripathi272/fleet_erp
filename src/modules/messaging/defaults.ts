import { model, Schema } from 'mongoose';
import { logger } from '../../core/logger/index.js';
import { getMaster } from '../../core/masters/registry.js';
import * as MasterService from '../../core/masters/service.js';
import type { Plain } from '../../core/masters/types.js';
import { Role } from '../roles/role.model.js';
import { type AUDIENCES, type EVENTS, type MESSAGE_CHANNELS, MessageTemplate, NotificationRule } from './models/messaging.model.js';

/**
 * The messages a new installation starts with (#43): a template for each event the trip and money steps
 * send (#29), per channel and audience, and a rule saying who gets it. They are the first client's way of
 * working, kept as ordinary records: the company edits, archives or deletes them like its own, and they
 * are created once, so its changes are never overwritten.
 *
 * Drivers get SMS: their WhatsApp chat already carries each step's message (the in-app thread, sent
 * through Marichi Talks). The office gets e-mail; the customer gets e-mail about its cargo, never the
 * trip's money.
 */

type Event = (typeof EVENTS)[number];
type Channel = (typeof MESSAGE_CHANNELS)[number];
type Audience = (typeof AUDIENCES)[number];

export interface DefaultTemplate { code: string; name: string; channel: Channel; event: Event; audience: Audience; subject?: string; body: string; buttons?: Array<{ label: string; action: string }>; providerTemplateId?: string }
type Recipient = { kind: 'driver' } | { kind: 'party_contact' } | { kind: 'role'; role: string };
export interface DefaultRule { code: string; name: string; event: Event; recipients: Recipient[]; templates: Array<{ channel: Channel | 'app'; template?: string }>; repeatEveryMinutes?: number; maxRepeats?: number }

const SIGN = '\n\n{{company.name}}';

export const DEFAULT_TEMPLATES: DefaultTemplate[] = [
  // Trips
  { code: 'SMS-DISPATCH', name: 'Dispatched (SMS to driver)', channel: 'sms', event: 'trip.dispatched', audience: 'driver', body: '{{trip.number}}: you are dispatched with {{vehicle.registration}} on {{route.name}}. Safe travels.' },
  { code: 'EM-TRIP-DISPATCHED', name: 'On its way (e-mail to customer)', channel: 'email', event: 'trip.dispatched', audience: 'customer', subject: '{{trip.number}}: truck {{vehicle.registration}} is on its way', body: `Hello,\n\nTruck {{vehicle.registration}}, driven by {{driver.name}}, left {{place.name}} on {{date}} for {{route.name}} (trip {{trip.number}}).\n\nWe will tell you when it reaches you.${SIGN}` },
  { code: 'EM-TRIP-AT-LOADING', name: 'At loading (e-mail to Operations)', channel: 'email', event: 'trip.arrived_loading', audience: 'operations', subject: '{{trip.number}} reached {{place.name}} for loading', body: `{{vehicle.registration}} ({{driver.name}}) reached {{place.name}} for loading on trip {{trip.number}}. Record the loading once the invoice is in.${SIGN}` },
  { code: 'SMS-TRIP-LOADED', name: 'Loaded (SMS to driver)', channel: 'sms', event: 'trip.loaded', audience: 'driver', body: '{{trip.number}}: loading at {{place.name}} is recorded (invoice {{document.number}}). Drive safe.' },
  { code: 'EM-TRIP-LOADED', name: 'Loaded (e-mail to customer)', channel: 'email', event: 'trip.loaded', audience: 'customer', subject: '{{trip.number}}: your cargo is loaded', body: `Hello,\n\nYour cargo is loaded on {{vehicle.registration}} at {{place.name}} (invoice {{document.number}}) and is on its way: {{route.name}}.${SIGN}` },
  { code: 'EM-TRIP-AT-OFFLOADING', name: 'Arriving (e-mail to customer)', channel: 'email', event: 'trip.arrived_offloading', audience: 'customer', subject: '{{trip.number}}: truck {{vehicle.registration}} has arrived', body: `Hello,\n\nTruck {{vehicle.registration}}, driven by {{driver.name}}, has reached {{place.name}} to offload trip {{trip.number}}.${SIGN}` },
  { code: 'SMS-TRIP-DELIVERED', name: 'Delivered (SMS to driver)', channel: 'sms', event: 'trip.delivered', audience: 'driver', body: '{{trip.number}}: delivery at {{place.name}} is recorded (note {{document.number}}). Thank you.' },
  { code: 'EM-TRIP-DELIVERED', name: 'Delivered (e-mail to customer)', channel: 'email', event: 'trip.delivered', audience: 'customer', subject: '{{trip.number}}: delivered at {{place.name}}', body: `Hello,\n\nTrip {{trip.number}} was delivered at {{place.name}} (delivery note {{document.number}}). Thank you for your business.${SIGN}` },
  { code: 'SMS-TRIP-CLOSED', name: 'Trip closed (SMS to driver)', channel: 'sms', event: 'trip.closed', audience: 'driver', body: '{{trip.number}} is closed. Truck {{vehicle.registration}} is parked at {{place.name}}. Thank you.' },
  { code: 'EM-TRIP-CLOSED', name: 'Trip sheet (e-mail to the office)', channel: 'email', event: 'trip.closed', audience: 'operations', subject: 'Trip sheet {{trip.number}}', body: `Trip {{trip.number}} ({{route.name}}) is closed. {{vehicle.registration}} is free at {{place.name}}.\n\nThe trip sheet is attached. The trip is ready to settle with {{driver.name}}.${SIGN}` },
  // Money requests
  { code: 'WA-ADV-REQ', name: 'Advance request to Finance', channel: 'whatsapp', event: 'fund_request.created', audience: 'finance', body: '{{driver.name}} needs {{currency}} {{amount}} for {{trip.number}} ({{route.name}}). Reason: {{reason}}', buttons: [{ label: 'Approve', action: 'approve' }, { label: 'Reject', action: 'reject' }], providerTemplateId: 'advance_request_v1' },
  { code: 'EM-FUND-REQUESTED', name: 'Money request (e-mail to Finance)', channel: 'email', event: 'fund_request.created', audience: 'finance', subject: '{{trip.number}}: {{amount}} {{currency}} requested', body: `{{amount}} {{currency}} is requested for trip {{trip.number}} ({{route.name}}), truck {{vehicle.registration}}, driver {{driver.name}}.\n\nReason: {{reason}}\n\nApprove or reject it in the app: {{link}}${SIGN}` },
  { code: 'EM-FUND-APPROVED', name: 'Request approved (e-mail to Operations)', channel: 'email', event: 'fund_request.approved', audience: 'operations', subject: '{{trip.number}}: {{amount}} {{currency}} approved', body: `The request for {{amount}} {{currency}} on trip {{trip.number}} is approved and waiting to be paid.${SIGN}` },
  { code: 'EM-FUND-REJECTED', name: 'Request rejected (e-mail to Operations)', channel: 'email', event: 'fund_request.rejected', audience: 'operations', subject: '{{trip.number}}: {{amount}} {{currency}} rejected', body: `The request for {{amount}} {{currency}} on trip {{trip.number}} was rejected.\n\nReason: {{reason}}${SIGN}` },
  { code: 'SMS-FUND-PAID', name: 'Paid (SMS to driver)', channel: 'sms', event: 'fund_request.paid', audience: 'driver', body: '{{trip.number}}: {{amount}} {{currency}} issued to you (ref {{document.number}}). Keep receipts for what you spend.' },
  { code: 'EM-FUND-PAID', name: 'Paid (e-mail to Operations)', channel: 'email', event: 'fund_request.paid', audience: 'operations', subject: '{{trip.number}}: {{amount}} {{currency}} paid', body: `{{amount}} {{currency}} for trip {{trip.number}} was paid (reference {{document.number}}).${SIGN}` },
  // Expenses
  { code: 'EM-EXPENSE-SUBMITTED', name: 'Expense to approve (e-mail to Finance)', channel: 'email', event: 'expense.submitted', audience: 'finance', subject: 'Expense to approve: {{document.name}} {{amount}} {{currency}}', body: `{{driver.name}} has a {{document.name}} expense of {{amount}} {{currency}} on trip {{trip.number}} (receipt {{document.number}}) waiting for approval.\n\n{{link}}${SIGN}` },
  { code: 'EM-SERVICE-DUE', name: 'Service due (e-mail to Operations)', channel: 'email', event: 'service.due', audience: 'operations', subject: 'Service due: {{vehicle.registration}}', body: `{{document.name}} on {{vehicle.registration}}: {{reason}}.${SIGN}` },
  { code: 'SMS-EXPENSE-APPROVED', name: 'Expense approved (SMS to driver)', channel: 'sms', event: 'expense.approved', audience: 'driver', body: 'Your {{document.name}} expense of {{amount}} {{currency}} is approved. It is off your balance.' },
  { code: 'SMS-EXPENSE-REJECTED', name: 'Expense rejected (SMS to driver)', channel: 'sms', event: 'expense.rejected', audience: 'driver', body: 'Your {{document.name}} expense of {{amount}} {{currency}} was not accepted: {{reason}}' },
  // Settlement
  { code: 'SMS-SETTLEMENT', name: 'Settled (SMS to driver)', channel: 'sms', event: 'settlement.posted', audience: 'driver', body: 'Settlement {{document.number}} for {{trip.number}} is posted. Carried forward: {{amount}} {{currency}}.' },
  { code: 'EM-SETTLEMENT', name: 'Statement (e-mail to driver)', channel: 'email', event: 'settlement.posted', audience: 'driver', subject: 'Your statement {{document.number}}', body: `Hello {{driver.name}},\n\nSettlement {{document.number}} covers {{trip.number}}. {{amount}} {{currency}} carries forward. Your statement is attached.${SIGN}` },
  // Nominations
  { code: 'EM-NOMINATION', name: 'Nomination (e-mail to customer)', channel: 'email', event: 'nomination.sent', audience: 'customer', subject: 'Nomination {{document.number}}: trucks for loading at {{place.name}}', body: `Hello,\n\nWe nominate {{vehicle.registration}} for loading at {{place.name}} on {{date}} (nomination {{document.number}}). Please confirm.${SIGN}` },
  // Documents
  { code: 'EMAIL-DOC-EXP', name: 'Document expiring e-mail', channel: 'email', event: 'document.expiring', audience: 'operations', subject: '{{document.name}} for {{vehicle.registration}} expires {{document.expiryDate}}', body: 'Hello,\n\n{{document.name}} {{document.number}} expires on {{document.expiryDate}}. Renew it to avoid blocking dispatch.\n\n{{company.name}}' },
];

const driver: Recipient = { kind: 'driver' };
const customer: Recipient = { kind: 'party_contact' };
const role = (key: string): Recipient => ({ kind: 'role', role: key });

export const DEFAULT_RULES: DefaultRule[] = [
  { code: 'TRIP-DISPATCHED-DRIVER', name: 'Tell the driver they are dispatched', event: 'trip.dispatched', recipients: [driver], templates: [{ channel: 'sms', template: 'SMS-DISPATCH' }] },
  { code: 'TRIP-DISPATCHED-CUSTOMER', name: 'Tell the customer the truck is on its way', event: 'trip.dispatched', recipients: [customer], templates: [{ channel: 'email', template: 'EM-TRIP-DISPATCHED' }] },
  { code: 'TRIP-AT-LOADING-OPS', name: 'Tell Operations a truck is at loading', event: 'trip.arrived_loading', recipients: [role('operations')], templates: [{ channel: 'email', template: 'EM-TRIP-AT-LOADING' }] },
  { code: 'TRIP-LOADED-DRIVER', name: 'Confirm the loading to the driver', event: 'trip.loaded', recipients: [driver], templates: [{ channel: 'sms', template: 'SMS-TRIP-LOADED' }] },
  { code: 'TRIP-LOADED-CUSTOMER', name: 'Tell the customer the cargo is loaded', event: 'trip.loaded', recipients: [customer], templates: [{ channel: 'email', template: 'EM-TRIP-LOADED' }] },
  { code: 'TRIP-AT-OFFLOADING-CUSTOMER', name: 'Tell the customer the truck has arrived', event: 'trip.arrived_offloading', recipients: [customer], templates: [{ channel: 'email', template: 'EM-TRIP-AT-OFFLOADING' }] },
  { code: 'TRIP-DELIVERED-DRIVER', name: 'Confirm the delivery to the driver', event: 'trip.delivered', recipients: [driver], templates: [{ channel: 'sms', template: 'SMS-TRIP-DELIVERED' }] },
  { code: 'TRIP-DELIVERED-CUSTOMER', name: 'Tell the customer the cargo is delivered', event: 'trip.delivered', recipients: [customer], templates: [{ channel: 'email', template: 'EM-TRIP-DELIVERED' }] },
  { code: 'TRIP-CLOSED-DRIVER', name: 'Tell the driver the trip is closed', event: 'trip.closed', recipients: [driver], templates: [{ channel: 'sms', template: 'SMS-TRIP-CLOSED' }] },
  { code: 'TRIP-CLOSED-OFFICE', name: 'Send the trip sheet to Operations and Finance', event: 'trip.closed', recipients: [role('operations'), role('finance')], templates: [{ channel: 'email', template: 'EM-TRIP-CLOSED' }] },
  { code: 'ADV-REQUEST', name: 'Tell Finance about money requests', event: 'fund_request.created', recipients: [role('finance')], templates: [{ channel: 'whatsapp', template: 'WA-ADV-REQ' }, { channel: 'email', template: 'EM-FUND-REQUESTED' }, { channel: 'app' }], repeatEveryMinutes: 60, maxRepeats: 3 },
  { code: 'FUND-APPROVED-OPS', name: 'Tell Operations a request is approved', event: 'fund_request.approved', recipients: [role('operations')], templates: [{ channel: 'email', template: 'EM-FUND-APPROVED' }] },
  { code: 'FUND-REJECTED-OPS', name: 'Tell Operations a request is rejected', event: 'fund_request.rejected', recipients: [role('operations')], templates: [{ channel: 'email', template: 'EM-FUND-REJECTED' }] },
  { code: 'FUND-PAID-DRIVER', name: 'Tell the driver money is issued', event: 'fund_request.paid', recipients: [driver], templates: [{ channel: 'sms', template: 'SMS-FUND-PAID' }] },
  { code: 'FUND-PAID-OPS', name: 'Tell Operations a request is paid', event: 'fund_request.paid', recipients: [role('operations')], templates: [{ channel: 'email', template: 'EM-FUND-PAID' }] },
  { code: 'EXPENSE-SUBMITTED-FINANCE', name: 'Tell Finance about expenses to approve', event: 'expense.submitted', recipients: [role('finance')], templates: [{ channel: 'email', template: 'EM-EXPENSE-SUBMITTED' }] },
  { code: 'SERVICE-DUE-OPERATIONS', name: 'Tell Operations a service is due', event: 'service.due', recipients: [role('operations')], templates: [{ channel: 'email', template: 'EM-SERVICE-DUE' }] },
  { code: 'EXPENSE-APPROVED-DRIVER', name: 'Tell the driver an expense is approved', event: 'expense.approved', recipients: [driver], templates: [{ channel: 'sms', template: 'SMS-EXPENSE-APPROVED' }] },
  { code: 'EXPENSE-REJECTED-DRIVER', name: 'Tell the driver an expense is rejected', event: 'expense.rejected', recipients: [driver], templates: [{ channel: 'sms', template: 'SMS-EXPENSE-REJECTED' }] },
  { code: 'SETTLEMENT-DRIVER', name: 'Send the driver their statement', event: 'settlement.posted', recipients: [driver], templates: [{ channel: 'sms', template: 'SMS-SETTLEMENT' }, { channel: 'email', template: 'EM-SETTLEMENT' }] },
  { code: 'NOMINATION-CUSTOMER', name: 'Send the nomination to the customer', event: 'nomination.sent', recipients: [customer], templates: [{ channel: 'email', template: 'EM-NOMINATION' }] },
  { code: 'DOC-EXPIRING-OPS', name: 'Tell Operations a document is expiring', event: 'document.expiring', recipients: [role('operations')], templates: [{ channel: 'email', template: 'EMAIL-DOC-EXP' }] },
];

/** One record per installation saying the default set was created, so it is never created again. */
const defaultsMark = model('MessageDefaults', new Schema({ _id: String, state: { type: String, enum: ['creating', 'done', 'skipped'] }, at: Date }, { collection: 'message_defaults', versionKey: false }));
const MARK = 'messages';

async function createIfMissing(key: 'message-templates' | 'notification-rules', code: string, data: Plain, actorId?: string) {
  const def = getMaster(key)!;
  const existing = await def.model.findOne({ code }).select('_id').lean() as Plain | null;
  if (existing) return String(existing._id);
  const record = await MasterService.create(def, def.createSchema.parse(data) as Plain, { actorId, canSeeSensitive: true });
  await def.model.updateOne({ _id: record.id }, { $set: { isDefault: true } });
  return String(record.id);
}

/**
 * Creates the default templates and rules on an installation that has none, once. An installation that
 * already has its own (or had the defaults once) is left alone: edits survive restarts, and what the
 * company deleted stays deleted. Safe to run on every start-up and from several instances at once.
 */
export async function ensureDefaultMessages(actorId?: string): Promise<{ created: number }> {
  const mark = await defaultsMark.findById(MARK).lean();
  if (mark?.state === 'done' || mark?.state === 'skipped') return { created: 0 };
  if (!mark) {
    if (await MessageTemplate.exists({}) || await NotificationRule.exists({})) {
      await defaultsMark.updateOne({ _id: MARK }, { $setOnInsert: { state: 'skipped', at: new Date() } }, { upsert: true });
      return { created: 0 };
    }
    // A start-up that died half-way leaves "creating"; the next one finishes, skipping what exists.
    await defaultsMark.updateOne({ _id: MARK }, { $setOnInsert: { state: 'creating', at: new Date() } }, { upsert: true });
  }
  let created = 0;
  const templateIds = new Map<string, string>();
  for (const t of DEFAULT_TEMPLATES) {
    const before = await MessageTemplate.exists({ code: t.code });
    templateIds.set(t.code, await createIfMissing('message-templates', t.code, { ...t, language: 'en' }, actorId));
    if (!before) created += 1;
  }
  const roles = new Map((await Role.find({}).select('key').lean()).map((r) => [String(r.key), String(r._id)]));
  for (const r of DEFAULT_RULES) {
    const recipients = r.recipients.map((x) => (x.kind === 'role' ? { kind: 'role', roleId: roles.get(x.role) } : { kind: x.kind }));
    if (recipients.some((x) => x.kind === 'role' && !x.roleId)) { logger.warn({ rule: r.code }, 'A default message rule names a role this installation lacks; skipped'); continue; }
    const before = await NotificationRule.exists({ code: r.code });
    await createIfMissing('notification-rules', r.code, {
      code: r.code, name: r.name, event: r.event, recipients,
      templates: r.templates.map((t) => (t.template ? { channel: t.channel, templateId: templateIds.get(t.template) } : { channel: t.channel })),
      ...(r.repeatEveryMinutes ? { repeatEveryMinutes: r.repeatEveryMinutes, maxRepeats: r.maxRepeats } : {}),
    }, actorId);
    if (!before) created += 1;
  }
  await defaultsMark.updateOne({ _id: MARK }, { $set: { state: 'done', at: new Date() } });
  if (created) logger.info({ created }, 'Default message templates and rules created');
  return { created };
}
