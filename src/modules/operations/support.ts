import type { Request } from 'express';
import type { Model } from 'mongoose';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../core/errors/index.js';
import { audit, comparable } from '../../core/masters/audit.js';
import { duplicateKeyError } from '../../core/masters/service.js';
import type { Action, Plain } from '../../core/masters/types.js';
import { Company } from '../company/company.model.js';
import { Driver } from '../drivers/models/driver.model.js';
import { Currency } from '../finance/models/currency.model.js';
import { convertMoney } from '../finance/finance.service.js';
import { nextCodeFor } from '../organisation/organisation.service.js';
import { Party } from '../parties/models/party.model.js';
import { sendWhatsApp } from './marichiTalks.js';
import { Activity, Message, OpsCounter } from './models/message.model.js';

/* ---------- Who is acting ---------- */

export type Desk = 'owner' | 'operations' | 'finance' | 'driver' | 'viewer';
export type Via = 'app' | 'whatsapp';

export interface OpsContext {
  actorId?: string;
  requestId?: string;
  name: string;
  /** The desk the actor works at, for trails, messages and the activity feed. */
  desk: Desk;
  can: (resource: string, action: Action) => boolean;
  /** Role keys, for approval levels that name a role. */
  roles: string[];
  /** Driver messages arrive from the driver app, over WhatsApp (Marichi Talks), or from the simulated phone. */
  asDriver?: boolean;
  /** The driver's own account (driver app): it may act only on that driver's work. */
  driverId?: string;
  /** Sent from a simulator, so records say they are not real. */
  simulated?: boolean;
}

/** Owner and Admin work at the owner's desk; otherwise the first operational role decides. */
export function deskOf(roles: string[]): Desk {
  if (roles.includes('owner') || roles.includes('admin')) return 'owner';
  if (roles.includes('operations')) return 'operations';
  if (roles.includes('finance')) return 'finance';
  return 'viewer';
}

export function opsContext(req: Request): OpsContext {
  const auth = req.auth!;
  return { actorId: auth.userId, requestId: req.requestId, name: auth.name, desk: deskOf(auth.roles), can: auth.can, roles: auth.roles };
}

export const DESK_NAME: Record<Desk, string> = { owner: 'Owner', operations: 'Operations', finance: 'Finance', driver: 'Driver', viewer: 'Viewer' };

/** A business rule said no. The message is a plain sentence for the screen. */
export const refuse = (message: string, details?: unknown) => new ValidationError(message, details);
/** The record is not in a state that allows this. */
export const conflict = (message: string, details?: unknown) => new ConflictError(message, details);

export function need(ctx: OpsContext, resource: string, action: Action, message?: string) {
  if (!ctx.can(resource, action)) throw new ForbiddenError(message ?? `Your role does not allow "${action}" on ${resource}`);
}

/* ---------- Records ---------- */

/** API shape: `id` instead of `_id`, ids and dates as strings. */
export function present(doc: unknown): Plain {
  const { _id, ...rest } = comparable(doc) as Plain;
  return { id: _id, ...rest };
}

/** An active master record, or a 422 naming what is missing. */
export async function activeRecord(model: Model<any>, id: unknown, label: string): Promise<Plain> {
  if (!id) throw refuse(`Choose the ${label}.`);
  const doc = await model.findById(id).lean();
  if (!doc || (doc as Plain).status !== 'active') throw refuse(`The ${label} was not found or is archived.`);
  return doc as Plain;
}

export async function loadOr404(model: Model<any>, id: string, label: string) {
  const doc = await model.findById(id);
  if (!doc) throw new NotFoundError(`${label} not found`);
  return doc;
}

/** Saves a document; a stale version or a clash on a unique index becomes a 409. */
export async function save(doc: { save: () => Promise<unknown> }, clash?: string) {
  try {
    await doc.save();
  } catch (err) {
    if (duplicateKeyError(err)) throw conflict(clash ?? 'This was already done by someone else. Reload and try again.');
    if (err && typeof err === 'object' && (err as { name?: string }).name === 'VersionError') throw conflict('This was changed by someone else. Reload and try again.');
    throw err;
  }
}

/** The customer party, which must hold the customer role. */
export async function customerParty(id: unknown) {
  const party = await activeRecord(Party, id, 'customer');
  if (!((party.roles as string[]) ?? []).includes('customer')) throw refuse(`${party.name} is not a customer.`);
  return party;
}

export async function activeDriver(id: unknown) {
  const driver = await activeRecord(Driver, id, 'driver');
  if (driver.blacklisted) throw refuse(`${driver.name} is blacklisted.`);
  return driver;
}

/* ---------- Numbers ---------- */

/**
 * The next document number. A numbering series for the document (e.g. "trips") is used when one is
 * active; otherwise PREFIX/YY/0001, counted per prefix and year.
 */
export async function nextNumber(entity: string, prefix: string, at = new Date()) {
  const fromSeries = await nextCodeFor(entity, {});
  if (fromSeries) return fromSeries;
  const key = `${prefix}/${String(at.getUTCFullYear()).slice(-2)}`;
  const counter = await OpsCounter.findOneAndUpdate({ _id: key }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' }).lean();
  return `${key}/${String((counter as { seq: number }).seq).padStart(4, '0')}`;
}

/* ---------- Money ---------- */

export interface CurrencyInfo { id: string; code: string; minorUnits: number }

export async function baseCurrency(): Promise<CurrencyInfo> {
  const company = await Company.findOne().select('baseCurrencyId').lean();
  const currency = company?.baseCurrencyId ? await Currency.findById(company.baseCurrencyId).lean() : null;
  if (!currency) throw refuse('Set the company base currency first (Company details).');
  return { id: String(currency._id), code: String(currency.code), minorUnits: Number(currency.minorUnits ?? 2) };
}

export async function currencyInfo(id: unknown): Promise<CurrencyInfo> {
  const currency = await Currency.findById(id).lean();
  if (!currency || currency.status !== 'active') throw refuse('The currency was not found or is archived.');
  return { id: String(currency._id), code: String(currency.code), minorUnits: Number(currency.minorUnits ?? 2) };
}

/** Converts minor units into the base currency at the latest rate on or before `date`. */
export async function toBase(amountMinor: number, currencyId: unknown, date = new Date()): Promise<{ baseMinor: number; rate: number }> {
  const base = await baseCurrency();
  if (String(currencyId) === base.id) return { baseMinor: amountMinor, rate: 1 };
  try {
    const result = await convertMoney({ amountMinor, fromCurrencyId: String(currencyId), toCurrencyId: base.id, date });
    return { baseMinor: result.resultMinor, rate: result.rate };
  } catch (err) {
    if (err instanceof NotFoundError) throw refuse(`${err.message}. Add the rate under Exchange rates.`);
    throw err;
  }
}

/** Converts minor units between two currencies at the latest rate on or before `date`. */
export async function convertTo(amountMinor: number, fromCurrencyId: unknown, toCurrencyId: unknown, date = new Date()) {
  if (String(fromCurrencyId) === String(toCurrencyId)) return amountMinor;
  try {
    return (await convertMoney({ amountMinor, fromCurrencyId: String(fromCurrencyId), toCurrencyId: String(toCurrencyId), date })).resultMinor;
  } catch (err) {
    if (err instanceof NotFoundError) throw refuse(`${err.message}. Add the rate under Exchange rates.`);
    throw err;
  }
}

/** "1,250.50 ZMW" for messages. */
export function formatMoney(amountMinor: number, currency: { code: string; minorUnits: number }) {
  // `|| 0` turns -0 (e.g. no expenses, negated) into 0, so it never shows as "-0".
  const value = amountMinor / 10 ** currency.minorUnits || 0;
  return `${value.toLocaleString('en-GB', { maximumFractionDigits: currency.minorUnits })} ${currency.code}`;
}
export const litres = (value: number) => `${Math.round(value).toLocaleString('en-GB')} L`;
export const firstName = (name?: unknown) => String(name ?? '').split(' ')[0] ?? '';
export const shortDate = (date: Date) => date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/* ---------- Messages and activity ---------- */

export interface MessageButton {
  label: string;
  tone?: 'primary' | 'danger';
  action?: Plain;
  attach?: string;
  nav?: Plain;
}
export interface Post {
  from?: 'bot' | 'me' | 'contact';
  text?: string;
  title?: string;
  rows?: Array<[string, string]>;
  attachment?: unknown;
  buttons?: MessageButton[];
  refId?: string;
}

/**
 * Threads: work queues (queue:<permission>), approval levels (role:<key> or user:<id>), and per contact.
 * A driver's thread is the driver's own WhatsApp: "me" is the driver and "bot" is Marichi.
 * A customer's thread is seen from the office: "me" is Operations and "contact" the customer.
 */
export const driverThread = (driverId: unknown) => `driver:${String(driverId)}`;
/** Work for anyone who may `create` on a permission resource, e.g. queue:payments. */
export const queue = (resource: string) => `queue:${resource}`;
export const customerThread = (partyId: unknown) => `customer:${String(partyId)}`;

/** Adds a message to a thread. Messages to a driver or customer also go out on WhatsApp. */
export async function post(thread: string, at: Date, message: Post, ctx?: OpsContext) {
  const from = message.from ?? 'bot';
  let delivery: Plain | undefined;
  const outbound = thread.startsWith('driver:') ? from === 'bot' : thread.startsWith('customer:') && from !== 'contact';
  if (outbound) {
    const to = await whatsAppNumberOf(thread);
    if (to) delivery = { ...(await sendWhatsApp({ to, text: message.text ?? '', title: message.title, buttons: message.buttons?.map((b) => b.label) })) };
  }
  await Message.create({ ...message, thread, from, text: message.text ?? '', at, userId: ctx?.actorId, ...(delivery ? { delivery } : {}) });
}

async function whatsAppNumberOf(thread: string): Promise<string | undefined> {
  const [kind, id] = thread.split(':');
  if (!id || !/^[0-9a-f]{24}$/.test(id)) return undefined;
  if (kind === 'driver') {
    const driver = await Driver.findById(id).select('whatsapp phone').lean();
    return (driver?.whatsapp ?? driver?.phone) as string | undefined;
  }
  const party = await Party.findById(id).select('contacts').lean();
  const contacts = (party?.contacts ?? []) as Array<{ whatsapp?: string; phone?: string; isPrimary?: boolean }>;
  const contact = contacts.find((c) => c.isPrimary) ?? contacts[0];
  return contact?.whatsapp ?? contact?.phone;
}

/** Marks the buttons on earlier messages about the same record as done. */
export async function resolve(refId: string, text: string) {
  await Message.updateMany({ refId, 'buttons.0': { $exists: true }, resolved: { $exists: false } }, { $set: { resolved: text } });
}

/** A line in the activity feed, and the same in the audit log against the record it concerns. */
export async function log(ctx: OpsContext, at: Date, text: string, target?: { tripId?: unknown; entity?: string; entityId?: unknown }) {
  await Activity.create({ at, tripId: target?.tripId, desk: ctx.asDriver ? 'driver' : ctx.desk, userId: ctx.actorId, text });
  const entity = target?.entity ?? (target?.tripId ? 'trips' : undefined);
  const entityId = target?.entityId ?? target?.tripId;
  if (entity && entityId) await audit({ entity, entityId, action: 'custom', summary: text, actorId: ctx.actorId, requestId: ctx.requestId });
}
