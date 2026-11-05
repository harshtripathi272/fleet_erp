import { NotFoundError, ValidationError } from '../../../core/errors/index.js';
import * as Fmt from '../../../core/format/regional.js';
import { logger } from '../../../core/logger/index.js';
import type { Plain } from '../../../core/masters/types.js';
import { dispatch, type DispatchInput } from '../../messaging/dispatcher.js';
import { Trip } from '../../operations/models/trip.model.js';
import {
  baseCurrency, conflict, customerParty, formatMoney, log, need, nextNumber, present, refuse, save, type OpsContext,
} from '../../operations/support.js';
import { partyName } from '../../operations/trips.service.js';
import { applyRate } from '../finance.service.js';
import { billingSettings } from '../settings.service.js';
import { Invoice } from './billing.model.js';
import type * as S from './billing.schema.js';
import { currencyUnits, invoiceCurrencyOf, priceTrip, rateFor, rateOrRefuse, termsOf, totalLine, totals, type Line, type PricedLine } from './pricing.js';

/**
 * Invoices and credit notes (#61). Drafts are priced from closed trips and can be edited; approving one numbers
 * it (INV/{YY}/{SEQ}, or the company's "invoices" numbering series), sets its due date from the payment terms
 * and fixes its rate to the base currency on the invoice's date. Approved invoices are corrected by credit notes.
 */

const day = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const NOT_CANCELLED = { status: { $ne: 'cancelled' } };

/** Trips already on an invoice that isn't cancelled. */
async function billedTripIds(tripIds: unknown[]) {
  const invoices = await Invoice.find({ kind: 'invoice', ...NOT_CANCELLED, tripIds: { $in: tripIds } }).select('tripIds').lean() as Plain[];
  return new Set(invoices.flatMap((i) => (i.tripIds as unknown[]).map(String)));
}

const CLOSED = { endedAt: { $exists: true }, cancelledAt: { $exists: false } };

/** Closed trips with no invoice yet, oldest first, each with why it can't be drafted when it can't. */
export async function unbilledTrips(query: S.UnbilledQuery) {
  const filter: Plain = { ...CLOSED, ...(query.customerId ? { customerId: query.customerId } : {}) };
  const billed = await Invoice.distinct('tripIds', { kind: 'invoice', ...NOT_CANCELLED });
  filter._id = { $nin: billed };
  const [rows, total] = await Promise.all([
    Trip.find(filter).sort({ endedAt: 1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
    Trip.countDocuments(filter),
  ]);
  const data = [];
  for (const t of rows as Plain[]) {
    const problem = await rateFor(t).then(() => undefined, (err: Error) => err.message);
    data.push({ id: String(t._id), number: t.number, customerId: String(t.customerId), customer: await partyName(t.customerId), nominationId: t.nominationId ? String(t.nominationId) : undefined, endedAt: t.endedAt, ...(problem ? { problem } : {}) });
  }
  return { data, page: query.page, limit: query.limit, total };
}

interface Group { customerId: string; nominationId?: unknown; trips: Plain[] }

/** Which trips go on one invoice, by Money settings → Invoice from. */
function groupTrips(trips: Plain[], from: string): Group[] {
  const groups = new Map<string, Group>();
  for (const t of trips) {
    const key = from === 'trip' ? String(t._id)
      : from === 'nomination' ? `${t.customerId}:${t.nominationId ?? t._id}`
        : String(t.customerId);
    const g = groups.get(key) ?? { customerId: String(t.customerId), nominationId: from === 'nomination' ? t.nominationId : undefined, trips: [] };
    g.trips.push(t);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/**
 * Drafts invoices from closed trips: the trips given, or every closed trip not yet invoiced (for one customer).
 * Each trip goes on one invoice, one per trip, per nomination (once all its trips are closed) or per customer,
 * by Money settings. A trip that can't be priced is listed with the reason, and the others are still drafted.
 */
export async function draftInvoices(input: S.DraftInvoicesInput, ctx: OpsContext) {
  need(ctx, 'invoices', 'create');
  const settings = await billingSettings();
  const date = input.date ?? day();
  const filter: Plain = input.tripIds ? { _id: { $in: input.tripIds } } : { ...CLOSED, ...(input.customerId ? { customerId: input.customerId } : {}) };
  const trips = await Trip.find(filter).sort({ endedAt: 1 }).limit(500).lean() as Plain[];
  if (input.tripIds && trips.length !== new Set(input.tripIds).size) throw new NotFoundError('Trip not found');
  const billed = await billedTripIds(trips.map((t) => t._id));
  const skipped: Array<{ tripId: string; number: unknown; reason: string }> = [];
  const open: Plain[] = [];
  for (const t of trips) {
    if (billed.has(String(t._id))) { if (input.tripIds) skipped.push({ tripId: String(t._id), number: t.number, reason: `${t.number} is already invoiced.` }); continue; }
    if (!t.endedAt || t.cancelledAt) { skipped.push({ tripId: String(t._id), number: t.number, reason: `${t.number} isn't closed yet.` }); continue; }
    open.push(t);
  }
  const drafted: Plain[] = [];
  for (const group of groupTrips(open, settings.invoiceFrom)) {
    if (group.nominationId) {
      const stillOpen = await Trip.countDocuments({ nominationId: group.nominationId, endedAt: { $exists: false }, cancelledAt: { $exists: false } });
      if (stillOpen) {
        for (const t of group.trips) skipped.push({ tripId: String(t._id), number: t.number, reason: `${stillOpen} more trip${stillOpen > 1 ? 's' : ''} of its nomination ${stillOpen > 1 ? 'are' : 'is'} still open.` });
        continue;
      }
    }
    try {
      drafted.push(await draftFor(group, date, settings, ctx));
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      for (const t of group.trips) skipped.push({ tripId: String(t._id), number: t.number, reason: err.message });
    }
  }
  return { drafted: await Promise.all(drafted.map(presentInvoice)), skipped };
}

async function draftFor(group: Group, date: Date, settings: Awaited<ReturnType<typeof billingSettings>>, ctx: OpsContext) {
  await customerParty(group.customerId);
  const terms = await termsOf(group.customerId);
  const currencyId = invoiceCurrencyOf(terms, await rateFor(group.trips[0]!));
  const lines: PricedLine[] = [];
  for (const trip of group.trips) lines.push(...await priceTrip(trip, currencyId, date, settings));
  const priced = lines.map((l) => totalLine(l, settings.pricesIncludeTax));
  const sums = totals(priced, settings.pricesIncludeTax);
  if (sums.totalMinor < 0) throw refuse(`The deductions on ${group.trips.map((t) => t.number).join(', ')} are more than the charges.`);
  const invoice = await Invoice.create({
    kind: 'invoice', customerId: group.customerId, nominationId: group.nominationId, tripIds: group.trips.map((t) => t._id),
    currencyId, date, lines: priced, ...sums, taxLabel: settings.taxLabel, pricesIncludeTax: settings.pricesIncludeTax,
    status: 'draft', createdBy: ctx.actorId, updatedBy: ctx.actorId,
  });
  await log(ctx, new Date(), `Invoice drafted for ${group.trips.map((t) => t.number).join(', ')}`, { entity: 'invoices', entityId: invoice._id });
  return invoice.toObject() as Plain;
}

/* ---------- Reading ---------- */

export async function presentInvoice(doc: Plain) {
  const currency = await currencyUnits(doc.currencyId);
  const out = present(doc);
  return { ...out, currency: currency.code, minorUnits: currency.minorUnits, customer: await partyName(doc.customerId), title: doc.number ?? (doc.kind === 'credit_note' ? 'Draft credit note' : 'Draft invoice') };
}

export async function listInvoices(query: S.InvoiceListQuery) {
  const filter: Plain = {};
  for (const key of ['customerId', 'kind', 'status'] as const) if (query[key]) filter[key] = query[key];
  if (query.open !== undefined) Object.assign(filter, query.open ? { status: 'approved', kind: 'invoice', openMinor: { $gt: 0 } } : { $or: [{ openMinor: 0 }, { status: { $ne: 'approved' } }] });
  const [rows, total] = await Promise.all([
    Invoice.find(filter).sort({ date: -1, _id: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
    Invoice.countDocuments(filter),
  ]);
  return { data: await Promise.all((rows as Plain[]).map(presentInvoice)), page: query.page, limit: query.limit, total };
}

async function invoiceDoc(id: string) {
  const doc = await Invoice.findById(id);
  if (!doc) throw new NotFoundError('Invoice not found');
  return doc;
}

export async function getInvoice(id: string) {
  const doc = (await invoiceDoc(id)).toObject() as Plain;
  const { CustomerPayment } = await import('./billing.model.js');
  const [credits, payments] = await Promise.all([
    Invoice.find({ invoiceId: doc._id, kind: 'credit_note' }).sort({ date: 1 }).lean(),
    CustomerPayment.find({ 'allocations.invoiceId': doc._id }).sort({ date: 1 }).lean(),
  ]);
  return {
    ...(await presentInvoice(doc)),
    creditNotes: await Promise.all((credits as Plain[]).map(presentInvoice)),
    payments: (payments as Plain[]).map((p) => ({
      id: String(p._id), number: p.number, date: p.date,
      ...present(((p.allocations ?? []) as Plain[]).find((a) => String(a.invoiceId) === String(doc._id)) ?? {}),
    })),
  };
}

const assertVersion = (doc: { get: (k: string) => unknown }, version: number) => {
  if (doc.get('version') !== version) throw conflict('This invoice was changed by someone else. Reload and try again.');
};

/* ---------- Drafts ---------- */

export async function updateDraft(id: string, input: S.UpdateDraftInput, ctx: OpsContext) {
  need(ctx, 'invoices', 'update');
  const doc = await invoiceDoc(id);
  assertVersion(doc, input.version);
  if (doc.get('status') !== 'draft') throw conflict('Only a draft can be changed. Correct an approved invoice with a credit note.');
  const includeTax = Boolean(doc.get('pricesIncludeTax'));
  if (input.currencyId && input.currencyId !== String(doc.get('currencyId')) && !input.lines) throw refuse('Send the lines in the new currency with it.');
  if (input.currencyId) await currencyUnits(input.currencyId);
  const set: Plain = { updatedBy: ctx.actorId };
  for (const key of ['date', 'dueDate', 'currencyId', 'note'] as const) if (input[key] !== undefined) set[key] = input[key];
  if (input.lines) {
    const existing = new Map(((doc.get('lines') ?? []) as Array<Plain & { _id: unknown }>).map((l) => [String(l._id), l]));
    const lines: Line[] = input.lines.map((l) => {
      const before = l.id ? existing.get(l.id) : undefined;
      if (l.id && !before) throw refuse('One of the lines is not on this invoice.');
      return totalLine({
        ...(before ? { tripId: before.tripId, consignmentId: before.consignmentId, rateId: before.rateId } : {}),
        kind: l.kind, description: l.description, qty: l.qty, unit: l.unit, unitPriceMinor: l.unitPriceMinor, taxPercent: l.taxPercent ?? 0,
      }, includeTax);
    });
    const sums = totals(lines, includeTax);
    if (sums.totalMinor < 0) throw refuse('The deductions are more than the charges.');
    Object.assign(set, { lines, ...sums });
  }
  doc.set(set);
  await save(doc);
  await log(ctx, new Date(), 'Draft invoice changed', { entity: 'invoices', entityId: doc._id });
  return presentInvoice(doc.toObject() as Plain);
}

export async function cancelInvoice(id: string, input: { version: number; reason: string }, ctx: OpsContext) {
  need(ctx, 'invoices', 'update');
  const doc = await invoiceDoc(id);
  assertVersion(doc, input.version);
  if (doc.get('status') !== 'draft') throw conflict('Only a draft can be cancelled. Correct an approved invoice with a credit note.');
  doc.set({ status: 'cancelled', cancelledAt: new Date(), reason: input.reason, updatedBy: ctx.actorId });
  await save(doc);
  await log(ctx, new Date(), `Draft cancelled: ${input.reason}`, { entity: 'invoices', entityId: doc._id });
  return presentInvoice(doc.toObject() as Plain);
}

/* ---------- Approval ---------- */

/**
 * Approves a draft: numbers it, sets its due date and fixes its rate to the base currency on its date.
 * A credit note takes its invoice's rate and reduces what is owed on it.
 */
export async function approveInvoice(id: string, version: number, ctx: OpsContext) {
  need(ctx, 'invoices', 'create');
  const doc = await invoiceDoc(id);
  assertVersion(doc, version);
  if (doc.get('status') !== 'draft') throw conflict('This is already approved or cancelled.');
  const total = Number(doc.get('totalMinor'));
  if (total <= 0) throw refuse('There is nothing to charge on this invoice.');
  const date = new Date(doc.get('date') as Date);
  const base = await baseCurrency();
  const currency = await currencyUnits(doc.get('currencyId'));
  const isCredit = doc.get('kind') === 'credit_note';
  let rateToBase: number;
  let baseTotal: number;
  let original: Awaited<ReturnType<typeof invoiceDoc>> | undefined;
  if (isCredit) {
    original = await invoiceDoc(String(doc.get('invoiceId')));
    const open = Number(original.get('openMinor'));
    if (original.get('status') !== 'approved') throw conflict('The invoice it credits is not approved.');
    if (total > open) throw refuse(`The credit is more than is still owed on ${original.get('number')} (${formatMoney(open, currency)}).`);
    rateToBase = Number(original.get('rateToBase'));
    baseTotal = total === open ? Number(original.get('baseOpenMinor')) : applyRate(total, rateToBase, currency.minorUnits, base.minorUnits);
  } else {
    rateToBase = currency.id === base.id ? 1 : await rateOrRefuse(currency.id, base.id, date);
    baseTotal = applyRate(total, rateToBase, currency.minorUnits, base.minorUnits);
  }
  const terms = await termsOf(doc.get('customerId'));
  const settings = await billingSettings();
  const days = Number(terms?.paymentTermsDays ?? settings.paymentTermsDays);
  const at = new Date();
  doc.set({
    number: isCredit ? await nextNumber('credit-notes', 'CRN', date) : await nextNumber('invoices', 'INV', date),
    status: 'approved', approvedAt: at, approvedBy: ctx.actorId, rateToBase, baseTotalMinor: baseTotal,
    ...(isCredit ? { openMinor: 0, baseOpenMinor: 0 } : { openMinor: total, baseOpenMinor: baseTotal, paymentState: 'unpaid', dueDate: doc.get('dueDate') ?? addDays(date, days) }),
    updatedBy: ctx.actorId,
  });
  await save(doc, 'This number is already taken. Try again.');
  if (original) {
    // What the credit takes off, in the invoice's currency and at its rate; the invoice cannot go below zero.
    const updated = await Invoice.findOneAndUpdate(
      { _id: original._id, openMinor: { $gte: total } },
      { $inc: { openMinor: -total, baseOpenMinor: -baseTotal, creditedMinor: total }, $set: { updatedBy: ctx.actorId } },
      { returnDocument: 'after' },
    );
    if (!updated) {
      doc.set({ status: 'draft', number: undefined, approvedAt: undefined, approvedBy: undefined });
      await doc.save();
      throw conflict('The invoice was paid or credited meanwhile. Reload and try again.');
    }
    await setPaymentState(updated._id);
  }
  await log(ctx, at, `${isCredit ? 'Credit note' : 'Invoice'} ${doc.get('number')} approved · ${formatMoney(total, currency)}`, { entity: 'invoices', entityId: doc._id });
  return presentInvoice(doc.toObject() as Plain);
}

/** unpaid, part paid or paid, from what is still owed. */
export async function setPaymentState(id: unknown) {
  const inv = await Invoice.findById(id).select('openMinor totalMinor creditedMinor paidMinor').lean() as Plain | null;
  if (!inv) return;
  const open = Number(inv.openMinor);
  const state = open <= 0 ? 'paid' : Number(inv.paidMinor ?? 0) > 0 || Number(inv.creditedMinor ?? 0) > 0 ? 'part_paid' : 'unpaid';
  await Invoice.updateOne({ _id: id }, { $set: { paymentState: state } });
}

/* ---------- Credit notes ---------- */

/** A draft credit note against an approved invoice: these lines, or (when nothing is paid or credited yet) all of its lines. */
export async function draftCreditNote(invoiceId: string, input: S.CreditNoteInput, ctx: OpsContext) {
  need(ctx, 'invoices', 'create');
  const invoice = (await invoiceDoc(invoiceId)).toObject() as Plain;
  if (invoice.kind !== 'invoice' || invoice.status !== 'approved') throw conflict('Only an approved invoice can be credited.');
  const includeTax = Boolean(invoice.pricesIncludeTax);
  let lines: Line[];
  if (input.lines) {
    lines = input.lines.map((l) => totalLine({ kind: l.kind, description: l.description, qty: l.qty, unit: l.unit, unitPriceMinor: l.unitPriceMinor, taxPercent: l.taxPercent ?? 0 }, includeTax));
  } else {
    if (Number(invoice.paidMinor ?? 0) > 0 || Number(invoice.creditedMinor ?? 0) > 0) throw refuse('Part of this invoice is paid or credited already: say which lines to credit.');
    lines = ((invoice.lines ?? []) as Line[]).map(({ kind, description, tripId, consignmentId, qty, unit, unitPriceMinor, taxPercent, amountMinor, taxMinor, netMinor }) => ({ kind, description, tripId, consignmentId, qty, unit, unitPriceMinor, taxPercent, amountMinor, taxMinor, netMinor }));
  }
  const sums = totals(lines, includeTax);
  if (sums.totalMinor <= 0) throw refuse('A credit note must credit something.');
  if (sums.totalMinor > Number(invoice.openMinor)) throw refuse('The credit is more than is still owed on this invoice.');
  const note = await Invoice.create({
    kind: 'credit_note', invoiceId: invoice._id, customerId: invoice.customerId, currencyId: invoice.currencyId, date: input.date ?? day(),
    lines, ...sums, taxLabel: invoice.taxLabel, pricesIncludeTax: includeTax, reason: input.reason, status: 'draft', createdBy: ctx.actorId, updatedBy: ctx.actorId,
  });
  await log(ctx, new Date(), `Credit note drafted against ${invoice.number}: ${input.reason}`, { entity: 'invoices', entityId: invoice._id });
  return presentInvoice(note.toObject() as Plain);
}

/* ---------- Sending ---------- */

/** Sends an approved invoice or credit note to the customer through the company's message rules, with its PDF. */
export async function sendInvoice(id: string, ctx: OpsContext) {
  need(ctx, 'invoices', 'update');
  const doc = await invoiceDoc(id);
  if (doc.get('status') !== 'approved') throw conflict('Approve it before sending it.');
  const plain = doc.toObject() as Plain;
  const currency = await currencyUnits(plain.currencyId);
  const { invoiceFile } = await import('./invoicePdf.js');
  const input: DispatchInput = {
    event: 'invoice.sent', partyId: String(plain.customerId), receives: 'invoices', ref: { kind: 'invoices', id: String(plain._id) }, actorId: ctx.actorId,
    variables: {
      'invoice.number': String(plain.number), 'invoice.kind': plain.kind === 'credit_note' ? 'credit note' : 'invoice',
      'invoice.total': formatMoney(Number(plain.totalMinor), currency), 'invoice.due': plain.kind === 'invoice' && plain.dueDate ? `Payment is due by ${Fmt.calendarDate(plain.dueDate as string)}.` : '',
    },
    attachments: async () => [await invoiceFile(String(plain._id), ctx.actorId)],
  };
  const messages = await dispatch(input, { background: true });
  if (!messages.length) throw refuse('Nothing was sent: no active message rule sends invoices, or the customer has no e-mail contact.');
  doc.set({ sentAt: new Date(), updatedBy: ctx.actorId });
  await save(doc);
  await log(ctx, new Date(), `${plain.number} sent to ${await partyName(plain.customerId)}`, { entity: 'invoices', entityId: doc._id });
  return { ...(await presentInvoice(doc.toObject() as Plain)), messages: messages.length };
}

/* ---------- From a closed trip ---------- */

/** When a trip closes: drafts its invoice if Billing is on and the company invoices each closed trip or nomination. */
export async function onTripClosed(tripId: string, actorId?: string) {
  const { isBillingOn } = await import('./billing.masters.js');
  if (!(await isBillingOn())) return;
  const settings = await billingSettings();
  if (settings.invoiceFrom === 'on_demand') return;
  const trip = await Trip.findById(tripId).select('nominationId').lean() as Plain | null;
  if (!trip) return;
  const tripIds = settings.invoiceFrom === 'nomination' && trip.nominationId
    ? (await Trip.find({ nominationId: trip.nominationId, ...CLOSED }).select('_id').lean()).map((t) => String(t._id))
    : [tripId];
  const ctx: OpsContext = { actorId, name: 'Billing', desk: 'finance', can: () => true, roles: [] };
  const result = await draftInvoices({ tripIds }, ctx);
  const reasons = result.skipped.filter((s) => !/already invoiced|still open/.test(s.reason));
  if (reasons.length) logger.warn({ tripId, skipped: reasons }, 'A closed trip could not be invoiced');
}
