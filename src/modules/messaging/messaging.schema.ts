import { z } from 'zod';
import { baseShape, code, integer, name, objectId, text, toUpdateSchema } from '../../core/masters/zod.js';
import { AUDIENCES, BUTTON_ACTIONS, EVENTS, MESSAGE_CHANNELS, PRINT_DOCUMENTS, RECIPIENT_KINDS } from './models/messaging.model.js';

export const messageTemplateShape = {
  code, name, description: text(500).optional(),
  channel: z.enum(MESSAGE_CHANNELS),
  event: z.enum(EVENTS),
  audience: z.enum(AUDIENCES).optional(),
  language: z.string().trim().regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'Language code, e.g. en, fr, sw or en-GB').optional(),
  subject: text(200).optional(),
  body: z.string().min(1).max(4096),
  buttons: z.array(z.strictObject({ label: text(20), action: z.enum(BUTTON_ACTIONS) })).max(3).optional(),
  providerTemplateId: z.string().trim().regex(/^[a-zA-Z0-9_.-]{1,80}$/, 'Template name registered with Marichi Talks').optional(),
  ...baseShape,
};

export const notificationRuleShape = {
  code, name, description: text(500).optional(),
  event: z.enum(EVENTS),
  recipients: z.array(z.strictObject({ kind: z.enum(RECIPIENT_KINDS), roleId: objectId.optional(), userId: objectId.optional() })).min(1).max(20),
  templates: z.array(z.strictObject({ channel: z.enum([...MESSAGE_CHANNELS, 'app']), templateId: objectId.optional() })).min(1).max(4),
  delayMinutes: integer(0, 10080).optional(),
  repeatEveryMinutes: integer(15, 10080).optional(),
  maxRepeats: integer(0, 10).optional(),
  ...baseShape,
};

export const printLayoutShape = {
  code, name, description: text(500).optional(),
  document: z.enum(PRINT_DOCUMENTS),
  paperSize: z.enum(['A4', 'A5', 'Letter']).optional(),
  orientation: z.enum(['portrait', 'landscape']).optional(),
  showLogo: z.boolean().optional(),
  sections: z.array(z.strictObject({ key: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,39}$/), label: text(80), visible: z.boolean(), order: integer(1, 100) })).max(40).optional(),
  signatureLines: z.array(text(60)).max(6).optional(),
  footerText: text(500).optional(),
  isDefault: z.boolean().optional(),
  ...baseShape,
};

export const createMessageTemplateSchema = z.strictObject(messageTemplateShape);
export const updateMessageTemplateSchema = toUpdateSchema(messageTemplateShape);
export const createNotificationRuleSchema = z.strictObject(notificationRuleShape);
export const updateNotificationRuleSchema = toUpdateSchema(notificationRuleShape);
export const createPrintLayoutSchema = z.strictObject(printLayoutShape);
export const updatePrintLayoutSchema = toUpdateSchema(printLayoutShape);

/** Variables as a list because their names contain dots (driver.name), which JSON keys may not. */
export const previewSchema = z.strictObject({
  variables: z.array(z.strictObject({ name: z.string().max(60), value: z.union([z.string().max(500), z.number()]) })).max(40).optional(),
}).default({});
export type PreviewInput = z.infer<typeof previewSchema>;

export const outboxQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(['queued', 'sending', 'sent', 'failed', 'simulated', 'skipped']).optional(),
  channel: z.enum(MESSAGE_CHANNELS).optional(),
  event: z.string().trim().regex(/^[a-z_]+\.[a-z_]+$|^account$/, 'An event, e.g. trip.dispatched').optional(),
  search: z.string().trim().min(1).max(100).optional(),
});
