import { createHash, randomUUID } from 'node:crypto';
import type { Plain } from '../../../core/masters/types.js';
import { storeForNew } from '../../../core/storage/index.js';
import { Company } from '../../company/company.model.js';
import { StoredFile } from '../../files/file.model.js';
import { dispatch } from '../../messaging/dispatcher.js';
import { renderPdf, type PdfBlock } from '../../operations/pdf.js';
import { customerParty, formatMoney, log, need, refuse, type OpsContext } from '../../operations/support.js';
import { partyName } from '../../operations/trips.service.js';
import { billingSettings } from '../settings.service.js';
import { CustomerPayment, Invoice } from './billing.model.js';
import { currencyUnits } from './pricing.js';

/**
 * Ageing and customer statements (#62). Ageing puts what each customer owes into columns by days past the
 * due date (current, then the company's buckets: 1–30, 31–60, 61–90, over 90 by default), per currency.
 * A statement lists a customer's invoices, credit notes and payments in one currency between two dates,
 * with the balance carried forward and its ageing.
 */

const DAY = 86_400_000;
const utcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export interface Bucket { key: string; label: string; from: number; to?: number }

/** Columns from the bucket ends: [30, 60, 90] → current, 1–30, 31–60, 61–90, over 90. */
export function bucketsFrom(ends: number[]): Bucket[] {
  const out: Bucket[] = [{ key: 'current', label: 'Current', from: -Infinity, to: 0 }];
  let from = 1;
  for (const end of ends) { out.push({ key: `${from}-${end}`, label: `${from}–${end} days`, from, to: end }); from = end + 1; }
  out.push({ key: `over-${from - 1}`, label: `Over ${from - 1} days`, from });
  return out;
}
const bucketOf = (buckets: Bucket[], daysLate: number) => buckets.find((b) => daysLate >= b.from && (b.to === undefined || daysLate <= b.to))!;

/** What each customer owes, by currency, in the ageing columns, as of `asOf` (today by default). */
export async function ageing(query: { asOf?: Date; customerId?: string }) {
  const asOf = utcDay(query.asOf ?? new Date());
  const buckets = bucketsFrom((await billingSettings()).ageingBucketsDays);
  const invoices = await Invoice.find({ kind: 'invoice', status: 'approved', openMinor: { $gt: 0 }, ...(query.customerId ? { customerId: query.customerId } : {}) })
    .select('number customerId currencyId date dueDate openMinor').sort({ dueDate: 1 }).lean() as Plain[];
  const rows = new Map<string, Plain & { buckets: Record<string, number>; totalMinor: number; invoices: Plain[] }>();
  const totals = new Map<string, Plain & { buckets: Record<string, number>; totalMinor: number }>();
  for (const inv of invoices) {
    const currency = await currencyUnits(inv.currencyId);
    const due = utcDay(new Date((inv.dueDate ?? inv.date) as string));
    const daysLate = Math.round((asOf.getTime() - due.getTime()) / DAY);
    const bucket = bucketOf(buckets, daysLate);
    const key = `${inv.customerId}:${currency.id}`;
    const row = rows.get(key) ?? { customerId: String(inv.customerId), customer: await partyName(inv.customerId), currency: currency.code, currencyId: currency.id, minorUnits: currency.minorUnits, buckets: Object.fromEntries(buckets.map((b) => [b.key, 0])), totalMinor: 0, invoices: [] };
    row.buckets[bucket.key]! += Number(inv.openMinor);
    row.totalMinor += Number(inv.openMinor);
    row.invoices.push({ id: String(inv._id), number: inv.number, dueDate: inv.dueDate, daysLate: Math.max(0, daysLate), bucket: bucket.key, openMinor: inv.openMinor });
    rows.set(key, row);
    const total = totals.get(currency.id) ?? { currency: currency.code, currencyId: currency.id, minorUnits: currency.minorUnits, buckets: Object.fromEntries(buckets.map((b) => [b.key, 0])), totalMinor: 0 };
    total.buckets[bucket.key]! += Number(inv.openMinor);
    total.totalMinor += Number(inv.openMinor);
    totals.set(currency.id, total);
  }
  return {
    asOf, buckets: buckets.map(({ key, label }) => ({ key, label })),
    customers: [...rows.values()].sort((a, b) => String(a.customer).localeCompare(String(b.customer))),
    totals: [...totals.values()],
  };
}

interface Entry { date: Date; kind: 'invoice' | 'credit_note' | 'payment'; number: string; description: string; debitMinor: number; creditMinor: number; balanceMinor?: number }

/** A customer's statement in one currency (its own currency by default) between two dates. */
export async function statement(customerId: string, query: { from?: Date; to?: Date; currencyId?: string }) {
  const party = await customerParty(customerId);
  const to = utcDay(query.to ?? new Date());
  const from = utcDay(query.from ?? new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1)));
  if (from > to) throw refuse('The statement starts after it ends.');
  const end = new Date(to.getTime() + DAY);
  const currencyId = query.currencyId ?? String(party.currencyId ?? (await Invoice.findOne({ customerId, status: 'approved' }).sort({ date: -1 }).select('currencyId').lean() as Plain | null)?.currencyId ?? '');
  if (!currencyId) throw refuse(`${party.name} has no invoices yet.`);
  const currency = await currencyUnits(currencyId);
  const documents = await Invoice.find({ customerId, currencyId, status: 'approved', date: { $lt: end } }).sort({ date: 1, approvedAt: 1 }).lean() as Plain[];
  const ids = new Set(documents.filter((d) => d.kind === 'invoice').map((d) => String(d._id)));
  const payments = await CustomerPayment.find({ customerId, date: { $lt: end } }).sort({ date: 1 }).lean() as Plain[];
  const all: Entry[] = documents.map((d) => ({
    date: new Date(d.date as string), kind: d.kind as Entry['kind'], number: String(d.number),
    description: d.kind === 'credit_note' ? `Credit note${d.reason ? `: ${d.reason}` : ''}` : `Invoice${d.dueDate ? `, due ${new Date(d.dueDate as string).toISOString().slice(0, 10)}` : ''}`,
    debitMinor: d.kind === 'invoice' ? Number(d.totalMinor) : 0, creditMinor: d.kind === 'credit_note' ? Number(d.totalMinor) : 0,
  }));
  for (const p of payments) {
    const parts = ((p.allocations ?? []) as Plain[]).filter((a) => ids.has(String(a.invoiceId)));
    const settled = parts.reduce((s, a) => s + Number(a.settledMinor), 0);
    if (!settled) continue;
    all.push({ date: new Date(p.date as string), kind: 'payment', number: String(p.number), description: `Payment against ${parts.map((a) => a.invoiceNumber).join(', ')}${p.reference ? ` (${p.reference})` : ''}`, debitMinor: 0, creditMinor: settled });
  }
  all.sort((a, b) => +a.date - +b.date);
  const before = all.filter((e) => e.date < from);
  const openingMinor = before.reduce((s, e) => s + e.debitMinor - e.creditMinor, 0);
  let balance = openingMinor;
  const entries = all.filter((e) => e.date >= from).map((e) => ({ ...e, balanceMinor: (balance += e.debitMinor - e.creditMinor) }));
  const aged = await ageing({ asOf: to, customerId });
  const row = aged.customers.find((c) => c.currencyId === currency.id);
  return {
    customerId, customer: party.name, currency: currency.code, currencyId: currency.id, minorUnits: currency.minorUnits, from, to,
    openingMinor, entries, closingMinor: balance, ageing: { buckets: aged.buckets, amounts: row?.buckets ?? Object.fromEntries(aged.buckets.map((b) => [b.key, 0])) },
  };
}

export async function statementPdf(customerId: string, query: { from?: Date; to?: Date; currencyId?: string }) {
  const s = await statement(customerId, query);
  const company = await Company.findOne().select('legalName tradingName phone email').lean() as Plain | null;
  const money = (minor: number) => formatMoney(minor, { code: s.currency, minorUnits: s.minorUnits });
  const day = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const blocks: PdfBlock[] = [
    { kind: 'title', text: `Statement for ${s.customer}` },
    { kind: 'subtitle', text: [company?.tradingName ?? company?.legalName, company?.phone, company?.email].filter(Boolean).join('  ·  ') },
    { kind: 'facts', rows: [['Period', `${day(s.from)} to ${day(s.to)}`], ['Currency', s.currency], ['Brought forward', money(s.openingMinor)]] },
    {
      kind: 'table',
      columns: [{ label: 'Date', width: 1.4 }, { label: 'Document', width: 1.6 }, { label: 'Details', width: 3.4 }, { label: 'Charged', width: 1.5, align: 'right' }, { label: 'Paid or credited', width: 1.5, align: 'right' }, { label: 'Balance', width: 1.6, align: 'right' }],
      rows: s.entries.map((e) => [day(e.date), e.number, e.description, e.debitMinor ? money(e.debitMinor) : '', e.creditMinor ? money(e.creditMinor) : '', money(e.balanceMinor)]),
    },
    { kind: 'facts', rows: [['Balance owed', money(s.closingMinor)]] },
    { kind: 'heading', text: 'Owed by days past due' },
    { kind: 'table', columns: s.ageing.buckets.map((b) => ({ label: b.label, width: 1, align: 'right' as const })), rows: [s.ageing.buckets.map((b) => money(Number(s.ageing.amounts[b.key] ?? 0)))] },
  ];
  const name = `Statement ${String(s.customer).replace(/[\\/:*?"<>|]+/g, '-')} ${s.to.toISOString().slice(0, 10)}.pdf`;
  return { name, body: renderPdf(blocks) };
}

/** Sends the statement to the customer's contact who receives statements, with its PDF. */
export async function sendStatement(customerId: string, query: { from?: Date; to?: Date; currencyId?: string }, ctx: OpsContext) {
  need(ctx, 'invoices', 'update');
  const s = await statement(customerId, query);
  const messages = await dispatch({
    event: 'statement.sent', partyId: customerId, receives: 'statements', actorId: ctx.actorId, ref: { kind: 'parties', id: customerId },
    variables: { 'statement.period': `${s.from.toISOString().slice(0, 10)} to ${s.to.toISOString().slice(0, 10)}`, 'statement.balance': formatMoney(s.closingMinor, { code: s.currency, minorUnits: s.minorUnits }) },
    attachments: async () => {
      const { name, body } = await statementPdf(customerId, query);
      if (!ctx.actorId) return null;
      const at = new Date();
      const key = `${at.toISOString().slice(0, 7)}/${randomUUID()}.pdf`;
      await (await storeForNew()).store.put(key, body, 'application/pdf');
      const file = await StoredFile.create({ name, mime: 'application/pdf', size: body.length, sha256: createHash('sha256').update(body).digest('hex'), key, uploadedBy: ctx.actorId, at });
      return [{ fileId: String(file._id) }];
    },
  }, { background: true });
  if (!messages.length) throw refuse('Nothing was sent: no active message rule sends statements, or the customer has no e-mail contact.');
  await log(ctx, new Date(), `Statement sent to ${s.customer} · balance ${formatMoney(s.closingMinor, { code: s.currency, minorUnits: s.minorUnits })}`, { entity: 'parties', entityId: customerId });
  return { messages: messages.length, closingMinor: s.closingMinor, currency: s.currency };
}
