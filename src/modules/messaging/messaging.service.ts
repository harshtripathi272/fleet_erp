
import { env } from '../../config/env.js';
import { productName } from '../company/brand.service.js';
import { baseCurrency } from '../operations/support.js';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '../../core/errors/index.js';
import { defineMaster } from '../../core/masters/define.js';
import { GROUPS } from '../../core/masters/groups.js';
import type { MasterDefinition, Plain } from '../../core/masters/types.js';
import * as Fmt from '../../core/format/regional.js';
import * as S from './messaging.schema.js';
import { CHANNEL_NAMES, EVENT_NAMES, EVENTS, MESSAGE_CHANNELS, MessageTemplate, NotificationRule, PRINT_DOCUMENTS, PrintLayout, VARIABLES } from './models/messaging.model.js';

const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;
/** A company field on an operational record: {{trip.custom.bookingRef}} (#67). */
const COMPANY_FIELD = /^(trip|consignment|request)\.custom\.[a-z][a-zA-Z0-9]{0,39}$/;
const push = (errors: Record<string, string[]>, key: string, message: string) => { (errors[key] ??= []).push(message); };

/** Placeholder names used in a text; reports malformed braces. */
export function placeholders(text: string): { names: string[]; problems: string[] } {
  const names = [...text.matchAll(PLACEHOLDER)].map((m) => m[1]!.trim());
  const problems: string[] = [];
  if (/\{\{|\}\}/.test(text.replace(PLACEHOLDER, ''))) problems.push('Unbalanced {{ or }}');
  for (const n of names) if (!(VARIABLES as readonly string[]).includes(n) && !COMPANY_FIELD.test(n)) problems.push(`Unknown placeholder {{${n}}}; use one of ${VARIABLES.join(', ')}`);
  return { names: [...new Set(names)], problems };
}

const GSM7 = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/;
/** SMS length: GSM-7 messages split at 153 characters (160 when single), others at 67 (70). */
export function smsSegments(text: string) {
  const gsm = GSM7.test(text);
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  return { encoding: gsm ? 'GSM-7' : 'UCS-2', characters: text.length, segments: text.length <= single ? 1 : Math.ceil(text.length / multi) };
}

export const messageTemplateDefinition = defineMaster({
  key: 'message-templates', label: 'Message templates', singular: 'Message template', group: GROUPS.messaging, lockedChoices: ['channel', 'event', 'audience'],
  description: 'The WhatsApp or SMS message (sent through the WhatsApp or SMS connection) or e-mail (sent over SMTP) for each event, with {{placeholders}} and WhatsApp buttons.',
  model: MessageTemplate, createSchema: S.createMessageTemplateSchema, updateSchema: S.updateMessageTemplateSchema,
  searchFields: ['code', 'name', 'event', 'body'],
  choiceLabels: { event: EVENT_NAMES, channel: CHANNEL_NAMES },
  filters: {
    channel: { schema: z.enum(MESSAGE_CHANNELS), apply: (v: string) => ({ channel: v }), description: 'Channel' },
    event: { schema: z.enum(EVENTS), apply: (v: string) => ({ event: v }), description: 'Event' },
  },
  async prepare(data: Plain) {
    const errors: Record<string, string[]> = {};
    const body = placeholders(String(data.body));
    if (body.problems.length) errors.body = body.problems;
    if (data.subject) {
      const subject = placeholders(String(data.subject));
      if (subject.problems.length) errors.subject = subject.problems;
    }
    if (data.channel === 'email' && !data.subject) push(errors, 'subject', 'E-mails need a subject');
    if (data.channel !== 'email' && data.subject) push(errors, 'subject', 'Only e-mails have a subject');
    if (data.channel !== 'whatsapp' && (data.buttons as unknown[] | undefined)?.length) push(errors, 'buttons', 'Only WhatsApp messages have buttons');
    if (data.channel === 'whatsapp' && String(data.body).length > 1024) push(errors, 'body', 'WhatsApp template bodies are limited to 1,024 characters');
    if (data.channel === 'sms' && smsSegments(String(data.body)).segments > 6) push(errors, 'body', 'SMS would be longer than 6 segments');
    const labels = ((data.buttons ?? []) as Array<{ label: string }>).map((b) => b.label.toLowerCase());
    if (new Set(labels).size !== labels.length) push(errors, 'buttons', 'Button labels must be unique');
    if (Object.keys(errors).length) throw new ValidationError('Template is not valid', errors);
    return data;
  },
});

export const notificationRuleDefinition = defineMaster({
  key: 'notification-rules', label: 'Notification rules', singular: 'Notification rule', group: GROUPS.messaging, lockedChoices: ['event', 'templates.channel', 'recipients.kind'],
  description: 'Who hears about an event, on which channels, with which template, after what delay, and how often to remind.',
  model: NotificationRule, createSchema: S.createNotificationRuleSchema, updateSchema: S.updateNotificationRuleSchema,
  searchFields: ['code', 'name', 'event'],
  choiceLabels: { event: EVENT_NAMES, 'templates.channel': { ...CHANNEL_NAMES, app: 'In the app' } },
  refs: [{ path: 'recipients.roleId', target: 'roles' }, { path: 'recipients.userId', target: 'users' }, { path: 'templates.templateId', target: 'message-templates' }],
  filters: { event: { schema: z.enum(EVENTS), apply: (v: string) => ({ event: v }), description: 'Event' } },
  async prepare(data: Plain) {
    const errors: Record<string, string[]> = {};
    (data.recipients as Array<{ kind: string; roleId?: unknown; userId?: unknown }>).forEach((r, i) => {
      if (r.kind === 'role' && !r.roleId) push(errors, 'recipients', `Recipient ${i + 1}: choose a role`);
      if (r.kind === 'user' && !r.userId) push(errors, 'recipients', `Recipient ${i + 1}: choose a user`);
      if (r.kind !== 'role' && r.roleId) push(errors, 'recipients', `Recipient ${i + 1}: only role recipients take a role`);
      if (r.kind !== 'user' && r.userId) push(errors, 'recipients', `Recipient ${i + 1}: only user recipients take a user`);
    });
    const templates = data.templates as Array<{ channel: string; templateId?: unknown }>;
    const channels = templates.map((t) => t.channel);
    if (new Set(channels).size !== channels.length) push(errors, 'templates', 'Each channel may appear once');
    for (const t of templates) {
      if (t.channel === 'app') { if (t.templateId) push(errors, 'templates', 'In-app notifications do not use a template'); continue; }
      if (!t.templateId) { push(errors, 'templates', `${t.channel}: choose a template`); continue; }
      const template = await MessageTemplate.findById(t.templateId).select('channel event').lean();
      if (template && template.channel !== t.channel) push(errors, 'templates', `${t.channel}: the template is for ${template.channel}`);
      if (template && template.event !== data.event) push(errors, 'templates', `${t.channel}: the template is for event ${template.event}`);
    }
    if (data.repeatEveryMinutes && !data.maxRepeats) push(errors, 'maxRepeats', 'Set how many reminders to send');
    if (Number(data.maxRepeats ?? 0) > 0 && !data.repeatEveryMinutes) push(errors, 'repeatEveryMinutes', 'Set how often to remind');
    if (Object.keys(errors).length) throw new ValidationError('Notification rule is not valid', errors);
    return data;
  },
});

export const printLayoutDefinition = defineMaster({
  key: 'print-layouts', label: 'Print layouts', singular: 'Print layout', group: GROUPS.messaging, lockedChoices: ['document'],
  description: 'Layouts for the trip sheet, driver statement, invoice and nomination slip: paper, sections, signatures and footer. One default per document.',
  model: PrintLayout, createSchema: S.createPrintLayoutSchema, updateSchema: S.updatePrintLayoutSchema,
  filters: { document: { schema: z.enum(PRINT_DOCUMENTS), apply: (v: string) => ({ document: v }), description: 'Document' } },
  async prepare(data: Plain) {
    const sections = (data.sections ?? []) as Array<{ key: string; order: number }>;
    const errors: Record<string, string[]> = {};
    if (new Set(sections.map((s) => s.key)).size !== sections.length) push(errors, 'sections', 'Section keys must be unique');
    if (new Set(sections.map((s) => s.order)).size !== sections.length) push(errors, 'sections', 'Section order numbers must be unique');
    if (Object.keys(errors).length) throw new ValidationError('Print layout is not valid', errors);
    return { ...data, sections: [...sections].sort((a, b) => a.order - b.order) };
  },
});

/** Made-up values a preview fills in, written in the company's own formats (#72). */
async function sampleValues(): Promise<Record<string, string>> {
  const base = await baseCurrency().catch(() => null);
  const now = new Date();
  return {
    'user.name': 'Mutale Chanda', 'driver.name': 'Joseph Mwansa', 'driver.phone': `${Fmt.regional().phoneCountryCode || '+'}971234567`,
    'vehicle.registration': 'ALC 4821', 'trailer.registration': 'TAC 7821', 'trip.number': 'TRIP/26/0137', 'route.name': 'Dar es Salaam port to Lusaka fuel depot',
    'place.name': 'Beira fuel terminal', 'customer.name': 'Zambezi Energy', amount: Fmt.amount(535_000, base?.minorUnits ?? 2), 'document.name': 'Road tax',
    'document.number': 'RT-2026-0042', 'document.expiryDate': Fmt.date(new Date(now.getTime() + 25 * 86_400_000)), reason: 'Above route budget', date: Fmt.date(now),
  };
}

/** Renders a template with the given variables (sample values fill the rest). */
export async function previewTemplate(id: string, input: S.PreviewInput) {
  const template = await MessageTemplate.findById(id).lean();
  if (!template) throw new NotFoundError('Message template not found');
  const given = Object.fromEntries((input.variables ?? []).map((v) => [v.name, String(v.value)]));
  const unknown = Object.keys(given).filter((k) => !(VARIABLES as readonly string[]).includes(k) && !COMPANY_FIELD.test(k));
  if (unknown.length) throw new ValidationError('Unknown variables', { variables: unknown.map((k) => `Unknown variable ${k}`) });
  // The company's own name, currency and address stand in for those placeholders, never another company's.
  const own: Record<string, string> = { 'company.name': await productName(), currency: (await baseCurrency().catch(() => null))?.code ?? '', link: `${env.APP_URL}/#t/abc` };
  const usedSample: string[] = [];
  const sample = await sampleValues();
  const render = (text: string) => text.replace(PLACEHOLDER, (_m, raw: string) => {
    const key = raw.trim();
    if (key in given) return given[key]!;
    usedSample.push(key);
    return own[key] ?? sample[key] ?? `{{${key}}}`;
  });
  const body = render(String(template.body));
  const subject = template.subject ? render(String(template.subject)) : undefined;
  return {
    channel: template.channel, subject, body, buttons: template.buttons ?? [],
    sampleValuesUsedFor: [...new Set(usedSample)],
    ...(template.channel === 'sms' ? { sms: smsSegments(body) } : {}),
    delivery: template.channel === 'email' ? 'E-mail connection' : `${CHANNEL_NAMES[template.channel as keyof typeof CHANNEL_NAMES] ?? template.channel} connection`,
  };
}

export const masters: MasterDefinition[] = [messageTemplateDefinition, notificationRuleDefinition, printLayoutDefinition];
