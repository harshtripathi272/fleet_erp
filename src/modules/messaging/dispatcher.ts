import type { Readable } from 'node:stream';
import mongoose, { Types } from 'mongoose';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors/index.js';
import { logger } from '../../core/logger/index.js';
import { type MailAttachment, type MailMessage, routeMail, sendOverSmtp, serverSmtp } from '../../core/mail/mailer.js';
import type { Plain } from '../../core/masters/types.js';
import { fileStore } from '../../core/storage/index.js';
import { Company } from '../company/company.model.js';
import { Driver } from '../drivers/models/driver.model.js';
import { StoredFile } from '../files/file.model.js';
import { Party } from '../parties/models/party.model.js';
import { User } from '../users/user.model.js';
import { type Channel, CHANNEL_LABEL, CHANNELS, connectionDefinition, isAddressFor, scrub, type Sender, senderFor, senderOn } from './connections.service.js';
import { MessageConnection, OutboundMessage, type OutboundRecord } from './models/connection.model.js';
import { EVENTS, MessageTemplate, NotificationRule } from './models/messaging.model.js';

/** Waits after the 1st, 2nd, ... failed attempt; after the last one the message is marked failed. */
export const RETRY_MINUTES = [1, 5, 15, 60, 240];
const LEASE_MS = 2 * 60000;
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;
const HIDDEN_BODY = '[Not kept: this e-mail held a one-time link]';

/** What an action passes when something happened. Everything else comes from the notification rules. */
export interface DispatchInput {
  event: (typeof EVENTS)[number];
  /** Values for the templates' {{placeholders}}; company.name, date, driver.* and customer.name are filled in. */
  variables?: Record<string, string | number | undefined | null>;
  /** The driver the event is about: "driver" recipients, and driver.name / driver.phone. */
  driverId?: string;
  /** The customer or other party: "party_contact" recipients, and customer.name. */
  partyId?: string;
  /**
   * Files sent with it: attached to e-mails; SMS and WhatsApp use the {{link}} placeholder instead.
   * A function is called only when an e-mail is actually going to someone, so a printout is made only when needed.
   */
  attachments?: Array<{ fileId: string }> | (() => Promise<Array<{ fileId: string }> | null>);
  /** The record it is about, e.g. { kind: 'trips', id }, shown in the outbox. */
  ref?: { kind: string; id: string };
  /** Which of the party's contacts it goes to: the first that receives these (invoices, statements), else the primary one. */
  receives?: string;
  actorId?: string;
}

interface Recipient { name: string; email?: string; phone?: string; whatsapp?: string }

const addressOf = (r: Recipient, channel: Channel) => (channel === 'email' ? r.email : channel === 'sms' ? r.phone : r.whatsapp ?? r.phone);

const render = (text: string, values: Record<string, string>) => text.replace(PLACEHOLDER, (_m, key: string) => values[key.trim()] ?? '');

async function recipientsFor(rule: Plain, input: DispatchInput): Promise<Recipient[]> {
  const out: Recipient[] = [];
  for (const r of (rule.recipients ?? []) as Array<{ kind: string; roleId?: unknown; userId?: unknown }>) {
    if (r.kind === 'role' && r.roleId) {
      const users = await User.find({ roleIds: r.roleId, status: 'active', driverId: { $exists: false } }).select('name email phone').limit(50).lean();
      out.push(...users.map((u) => ({ name: u.name, email: u.email, phone: u.phone })));
    } else if (r.kind === 'user' && r.userId) {
      const u = await User.findOne({ _id: r.userId, status: 'active' }).select('name email phone').lean();
      if (u) out.push({ name: u.name, email: u.email, phone: u.phone });
    } else if (r.kind === 'driver' && input.driverId && Types.ObjectId.isValid(input.driverId)) {
      const d = await Driver.findById(input.driverId).select('name phone whatsapp email').lean() as Plain | null;
      if (d) out.push({ name: String(d.name), email: d.email as string | undefined, phone: d.phone as string | undefined, whatsapp: d.whatsapp as string | undefined });
    } else if (r.kind === 'party_contact' && input.partyId && Types.ObjectId.isValid(input.partyId)) {
      const p = await Party.findById(input.partyId).select('name email phone whatsapp contacts').lean() as Plain | null;
      if (!p) continue;
      const contacts = (p.contacts ?? []) as Array<Recipient & { isPrimary?: boolean }>;
      const primary = (input.receives ? contacts.find((c) => ((c as { receives?: string[] }).receives ?? []).includes(input.receives!)) : undefined)
        ?? contacts.find((c) => c.isPrimary) ?? contacts[0];
      out.push({
        name: String(p.name),
        email: (input.receives ? primary?.email : undefined) ?? (p.email as string | undefined) ?? primary?.email,
        phone: (p.phone as string | undefined) ?? primary?.phone,
        whatsapp: (p.whatsapp as string | undefined) ?? primary?.whatsapp,
      });
    }
  }
  return out;
}

async function valuesFor(input: DispatchInput): Promise<Record<string, string>> {
  const company = await Company.findOne().select('legalName tradingName').lean() as Plain | null;
  const values: Record<string, string> = { date: new Date().toISOString().slice(0, 10) };
  if (company) values['company.name'] = String(company.tradingName ?? company.legalName);
  if (input.driverId && Types.ObjectId.isValid(input.driverId)) {
    const d = await Driver.findById(input.driverId).select('name phone').lean() as Plain | null;
    if (d) { values['driver.name'] = String(d.name); values['driver.phone'] = String(d.phone ?? ''); }
  }
  if (input.partyId && Types.ObjectId.isValid(input.partyId)) {
    const p = await Party.findById(input.partyId).select('name').lean() as Plain | null;
    if (p) values['customer.name'] = String(p.name);
  }
  for (const [k, v] of Object.entries(input.variables ?? {})) if (v !== undefined && v !== null) values[k] = String(v);
  return values;
}

/**
 * Sends what the company's notification rules say for an event: each rule's template on each of its
 * channels, to each of its recipients. Every message is recorded in the outbox first, then sent, so
 * nothing is lost if a provider is down; failures retry with back-off. Never throws for a send that
 * fails; an action is never undone because a message could not go.
 */
export async function dispatch(input: DispatchInput, { background = false }: { background?: boolean } = {}) {
  if (!(EVENTS as readonly string[]).includes(input.event)) throw new ValidationError(`Unknown event ${input.event}`);
  const rules = await NotificationRule.find({ event: input.event, status: 'active' }).lean() as Plain[];
  if (!rules.length) return [];
  const values = await valuesFor(input);
  const now = Date.now();
  const seen = new Set<string>();
  // Who gets what first, then the records: an attachment is only made when an e-mail has somewhere to go.
  const planned: Array<{ rule: Plain; template: Plain; channel: Channel; recipient: Recipient; to?: string }> = [];
  for (const rule of rules) {
    const recipients = await recipientsFor(rule, input);
    for (const entry of (rule.templates ?? []) as Array<{ channel: string; templateId?: unknown }>) {
      if (!(CHANNELS as readonly string[]).includes(entry.channel) || !entry.templateId) continue;
      const channel = entry.channel as Channel;
      const template = await MessageTemplate.findOne({ _id: entry.templateId, status: 'active' }).lean() as Plain | null;
      if (!template) continue;
      for (const recipient of recipients) {
        const to = addressOf(recipient, channel);
        const key = `${channel}:${to ?? recipient.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        planned.push({ rule, template, channel, recipient, to });
      }
    }
  }
  const attachments = planned.some((p) => p.channel === 'email' && p.to) ? await attachmentNames(input.attachments) : [];
  const created: OutboundRecord[] = [];
  for (const { rule, template, channel, recipient, to } of planned) {
    created.push((await OutboundMessage.create({
      event: input.event, channel, to, toName: recipient.name,
      subject: template.subject ? render(String(template.subject), values) : undefined,
      body: render(String(template.body), values),
      attachments: channel === 'email' && attachments.length ? attachments : undefined,
      status: to ? 'queued' : 'skipped',
      note: to ? undefined : `${recipient.name} has no ${channel === 'email' ? 'e-mail address' : 'phone number'}`,
      nextAttemptAt: to ? new Date(now + Number(rule.delayMinutes ?? 0) * 60000) : undefined,
      ruleId: rule._id as Types.ObjectId, templateId: template._id as Types.ObjectId, ref: input.ref, createdBy: input.actorId, at: new Date(now),
    })).toObject());
  }
  const due = created.filter((m) => m.status === 'queued' && m.nextAttemptAt! <= new Date());
  if (background) {
    track((async () => { for (const message of due) await deliver(message._id); })());
    return created.map(present);
  }
  for (const message of due) await deliver(message._id);
  return Promise.all(created.map(async (m) => present((await OutboundMessage.findById(m._id).lean())!)));
}

/** Sends begun by notify() that have not finished yet. */
const inFlight = new Set<Promise<void>>();
function track(run: Promise<void>) {
  const done: Promise<void> = run.catch((err: unknown) => { logger.error({ err }, 'Sending queued messages failed'); }).finally(() => { inFlight.delete(done); });
  inFlight.add(done);
}

/** Waits for the sends notify() started: for tests, and for a clean shutdown. */
export async function settleSends(): Promise<void> {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
}

/**
 * For actions: records the event's messages in the outbox, then sends them without holding the action
 * up. A slow or failing provider never fails the action; what does not go is retried by the worker.
 * Only logs when the messages could not even be prepared.
 */
export async function notify(input: DispatchInput): Promise<void> {
  try { await dispatch(input, { background: true }); } catch (err) { logger.error({ err, event: input.event }, 'Messages for an event could not be prepared'); }
  for (const listener of listeners.get(input.event) ?? []) {
    try { await listener(input); } catch (err) { logger.error({ err, event: input.event }, 'Work that follows an event failed'); }
  }
}

type Listener = (input: DispatchInput) => Promise<void>;
const listeners = new Map<string, Listener[]>();

/**
 * Work another area does when something happens, after its messages (billing drafts an invoice when a trip closes).
 * A listener that fails is logged; it never undoes the step or stops the other listeners.
 */
export function onEvent(event: DispatchInput['event'], listener: Listener) {
  listeners.set(event, [...(listeners.get(event) ?? []), listener]);
}

async function attachmentNames(given: DispatchInput['attachments']) {
  const out: Array<{ fileId: Types.ObjectId; name: string }> = [];
  let list: Array<{ fileId: string }> | null | undefined;
  try {
    list = typeof given === 'function' ? await given() : given;
  } catch (err) {
    // The messages still go, without the file; the log says why.
    logger.error({ err }, 'An attachment could not be made');
  }
  for (const a of list ?? []) {
    if (!Types.ObjectId.isValid(a.fileId)) continue;
    const file = await StoredFile.findById(a.fileId).select('name').lean();
    if (file) out.push({ fileId: file._id, name: file.name });
  }
  return out;
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks);
}

async function loadAttachments(list: OutboundRecord['attachments']): Promise<MailAttachment[]> {
  const out: MailAttachment[] = [];
  for (const a of list ?? []) {
    const file = a.fileId ? await StoredFile.findById(a.fileId).lean() : null;
    if (!file) throw new Error(`Attachment ${a.name} is no longer available`);
    out.push({ filename: file.name, contentType: file.mime, content: await readAll(await (await fileStore()).open(file.key)) });
  }
  return out;
}

/**
 * Sends one queued message, once: it is claimed first, so two workers (or two API instances) never
 * send it twice. `override` carries text the outbox does not keep (one-time links); `sender` sends on a
 * given connection instead of the channel's current one; `once` makes a failure final (no retries).
 */
interface DeliverOptions { override?: { text: string; attachments?: MailAttachment[] }; sender?: Sender; once?: boolean }
async function deliver(id: Types.ObjectId, { override, sender, once }: DeliverOptions = {}): Promise<OutboundRecord | null> {
  const now = new Date();
  const message = await OutboundMessage.findOneAndUpdate(
    { _id: id, status: 'queued' }, { $set: { status: 'sending', leaseUntil: new Date(now.getTime() + LEASE_MS) } }, { returnDocument: 'after' },
  ).lean();
  if (!message) return null;
  const via = sender ?? await senderFor(message.channel);
  const connectionId = via.connection?._id as Types.ObjectId | undefined;
  if (via.simulated || !via.send) {
    return OutboundMessage.findByIdAndUpdate(id, { $set: { status: 'simulated', note: via.simulated, connectionId }, $unset: { leaseUntil: 1, nextAttemptAt: 1 } }, { returnDocument: 'after' }).lean();
  }
  const attempts = message.attempts + 1;
  try {
    const result = await via.send({
      to: message.to!, subject: message.subject, text: override?.text ?? message.body,
      attachments: override?.attachments ?? (message.attachments?.length ? await loadAttachments(message.attachments) : undefined),
    });
    if (connectionId) await MessageConnection.updateOne({ _id: connectionId }, { $set: { lastSentAt: new Date() } });
    return OutboundMessage.findByIdAndUpdate(id, {
      $set: { status: result.simulated ? 'simulated' : 'sent', attempts, sentAt: new Date(), providerRef: result.providerRef, connectionId, ...(result.simulated ? { note: 'Sent through a simulated provider' } : {}) },
      $unset: { leaseUntil: 1, nextAttemptAt: 1, ...(result.simulated ? {} : { note: 1 }) },
    }, { returnDocument: 'after' }).lean();
  } catch (err) {
    const error = scrub(err instanceof Error ? err.message : String(err), via.connection);
    const giveUp = once || attempts >= RETRY_MINUTES.length || Boolean(message.sensitive);
    if (connectionId) await MessageConnection.updateOne({ _id: connectionId }, { $set: { lastError: { at: new Date(), message: error } } });
    logger.warn({ outboxId: String(id), channel: message.channel, attempts, error }, giveUp ? 'Message failed; giving up' : 'Message failed; will retry');
    return OutboundMessage.findByIdAndUpdate(id, giveUp
      ? { $set: { status: 'failed', attempts, note: error, connectionId }, $unset: { leaseUntil: 1, nextAttemptAt: 1 } }
      : { $set: { status: 'queued', attempts, note: error, connectionId, nextAttemptAt: new Date(Date.now() + RETRY_MINUTES[attempts - 1]! * 60000) }, $unset: { leaseUntil: 1 } },
    { returnDocument: 'after' }).lean();
  }
}

/** Sends what is due: new messages whose delay has passed, retries whose wait is over, and any a crashed worker left half-sent. */
export async function processDue(limit = 25): Promise<number> {
  const now = new Date();
  await OutboundMessage.updateMany({ status: 'sending', leaseUntil: { $lt: now } }, { $set: { status: 'queued', nextAttemptAt: now }, $unset: { leaseUntil: 1 } });
  const due = await OutboundMessage.find({ status: 'queued', nextAttemptAt: { $lte: now } }).sort({ nextAttemptAt: 1 }).limit(limit).select('_id').lean();
  let sent = 0;
  for (const m of due) if (await deliver(m._id)) sent += 1;
  return sent;
}

let worker: NodeJS.Timeout | undefined;
/** Runs processDue every `intervalMs` in this process. Safe on several instances: each message is claimed before sending. */
export function startOutboxWorker(intervalMs = 30000) {
  if (worker) return;
  worker = setInterval(() => { processDue().catch((err) => logger.error({ err }, 'Outbox worker failed')); }, intervalMs);
  worker.unref();
}
export function stopOutboxWorker() { if (worker) clearInterval(worker); worker = undefined; }

/** Sends a copy of a message again, now. One-time links are never resent; send a new one instead. */
export async function resend(id: string, actorId?: string) {
  const original = await OutboundMessage.findById(id).lean();
  if (!original) throw new NotFoundError('Message not found');
  if (original.sensitive) throw new ConflictError('This e-mail held a one-time link, so it is not kept and cannot be resent. Send a new one, e.g. with "Forgot password" or "Resend invitation".');
  if (original.status === 'queued' || original.status === 'sending') throw new ConflictError('This message is still being sent');
  if (!original.to) throw new ConflictError(original.note ?? 'This message has no recipient address');
  const copy = await OutboundMessage.create({
    event: original.event, channel: original.channel, to: original.to, toName: original.toName, subject: original.subject, body: original.body,
    attachments: original.attachments, status: 'queued', nextAttemptAt: new Date(), ruleId: original.ruleId, templateId: original.templateId,
    ref: original.ref, resentFromId: original._id, createdBy: actorId, at: new Date(),
  });
  await deliver(copy._id);
  return present((await OutboundMessage.findById(copy._id).lean())!);
}

const TEST_TEXT = 'This is a test message from Marichi Fleet. If you received it, this connection works.';

/** "Send a test message" on a connection, switched on or not. The result is kept on the connection and in the outbox. */
export async function testConnection(id: string, to: string, actorId?: string) {
  const connection = await MessageConnection.findById(id).lean() as Plain | null;
  if (!connection) throw new NotFoundError('Message connection not found');
  const channel = connection.channel as Channel;
  if (!isAddressFor(channel, to)) throw new ValidationError('Check the address', { to: [channel === 'email' ? 'An e-mail address' : 'A phone number with its country code, e.g. +260971234567'] });
  const message = await OutboundMessage.create({
    event: 'connection.test', channel, to, subject: channel === 'email' ? 'Marichi Fleet test message' : undefined, body: TEST_TEXT,
    status: 'queued', nextAttemptAt: new Date(), connectionId: connection._id as Types.ObjectId, ref: { kind: 'message-connections', id }, createdBy: actorId, at: new Date(),
  });
  // One attempt, on this connection, whether or not it is switched on.
  const result = await deliver(message._id, { sender: senderOn(connection), once: true });
  const ok = result?.status === 'sent' || result?.status === 'simulated';
  const lastTest = { at: new Date(), ok, to, error: ok ? undefined : result?.note };
  await MessageConnection.updateOne({ _id: connection._id }, { $set: { lastTest } });
  return { ok, status: ok ? result!.status : 'failed', note: result?.note, message: present((await OutboundMessage.findById(message._id).lean())!) };
}

export function present(m: OutboundRecord) {
  return {
    id: String(m._id), event: m.event, channel: m.channel, channelLabel: CHANNEL_LABEL[m.channel], to: m.to, toName: m.toName,
    subject: m.subject, body: m.body, attachments: (m.attachments ?? []).map((a) => a.name),
    status: m.status, note: m.note, attempts: m.attempts, nextAttemptAt: m.nextAttemptAt, providerRef: m.providerRef, sentAt: m.sentAt,
    connectionId: m.connectionId ? String(m.connectionId) : undefined, ref: m.ref, resentFromId: m.resentFromId ? String(m.resentFromId) : undefined,
    resendable: !m.sensitive && Boolean(m.to) && !['queued', 'sending'].includes(m.status), at: m.at,
  };
}

export interface OutboxQuery { page: number; limit: number; status?: string; channel?: string; event?: string; search?: string }
export async function listOutbox(q: OutboxQuery) {
  const filter: Plain = {};
  if (q.status) filter.status = q.status;
  if (q.channel) filter.channel = q.channel;
  if (q.event) filter.event = q.event;
  if (q.search) filter.$or = ['to', 'toName', 'subject'].map((f) => ({ [f]: { $regex: q.search!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }));
  const [rows, total] = await Promise.all([
    OutboundMessage.find(filter).sort({ at: -1, _id: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    OutboundMessage.countDocuments(filter),
  ]);
  return { data: rows.map(present), total, page: q.page, limit: q.limit };
}

export async function getOutboxMessage(id: string) {
  const m = await OutboundMessage.findById(id).lean();
  if (!m) throw new NotFoundError('Message not found');
  return present(m);
}

/**
 * E-mails sent with `sendMail` (resets, invitations) go through here too: on the e-mail connection,
 * recorded in the outbox. Their text holds a one-time link, so it is sent but never kept or resent.
 */
async function routeAccountMail(m: MailMessage): Promise<boolean> {
  const sensitive = m.sensitive ?? !m.event;
  // Without the database (start-up, some tests) there is no outbox: send on the server's settings, if any.
  if (mongoose.connection.readyState !== 1) {
    const smtp = serverSmtp();
    if (!smtp) return false;
    try { await sendOverSmtp(smtp, m); return true; } catch (err) { logger.error({ err, subject: m.subject }, 'E-mail delivery failed'); return false; }
  }
  try {
    const record = await OutboundMessage.create({
      event: m.event ?? 'account', channel: 'email', to: m.to, subject: m.subject, body: sensitive ? HIDDEN_BODY : m.text,
      status: 'queued', nextAttemptAt: new Date(), sensitive, at: new Date(),
    });
    const result = await deliver(record._id, { override: { text: m.text, attachments: m.attachments } });
    return result?.status === 'sent';
  } catch (err) {
    logger.error({ err, subject: m.subject }, 'E-mail could not be recorded or sent');
    return false;
  }
}
routeMail(routeAccountMail);

export { connectionDefinition };
