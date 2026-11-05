import type { Plain } from '../../../core/masters/types.js';
import { Driver } from '../../drivers/models/driver.model.js';
import { FundRequest } from '../../operations/models/funding.model.js';
import { Trip } from '../../operations/models/trip.model.js';
import { Expense } from '../../operations/models/money.model.js';
import { baseCurrency, refuse } from '../../operations/support.js';
import { Party } from '../../parties/models/party.model.js';
import { applyRate } from '../finance.service.js';
import { AccountCode, CustomerPayment, ExchangeDifference, Invoice, POSTING_ROLES } from './billing.model.js';
import { POSTING_LABELS } from './billing.masters.js';
import { currencyUnits } from './pricing.js';

/**
 * The accounting export (#62): every posting between two dates as double-entry lines in the base currency,
 * each with the company's account code (Account codes master), as CSV. Invoices and credit notes, payments
 * with their realised exchange gain or loss, revaluations and their reversals, cash advanced to drivers and
 * approved expenses. The accounting connection will send the same lines; the CSV is the first format.
 */

type Role = (typeof POSTING_ROLES)[number];
export interface Posting {
  date: Date; journal: string; document: string; party: string; role: Role; description: string;
  debitMinor: number; creditMinor: number; currency: string; amountMinor?: number; units?: number;
}

const DAY = 86_400_000;

export async function postings(range: { from: Date; to: Date }): Promise<Posting[]> {
  const base = await baseCurrency();
  const between = { $gte: range.from, $lt: new Date(range.to.getTime() + DAY) };
  const names = new Map<string, string>();
  const partyName = async (id: unknown) => {
    const key = String(id);
    if (!names.has(key)) names.set(key, String((await Party.findById(id).select('name').lean() as Plain | null)?.name ?? ''));
    return names.get(key)!;
  };
  const out: Posting[] = [];
  const line = (p: Omit<Posting, 'debitMinor' | 'creditMinor'>, minor: number) => {
    if (!minor) return;
    out.push({ ...p, debitMinor: minor > 0 ? minor : 0, creditMinor: minor < 0 ? -minor : 0 });
  };

  // Invoices and credit notes: owed by the customer against income and tax.
  for (const d of await Invoice.find({ status: 'approved', date: between }).sort({ date: 1 }).lean() as Plain[]) {
    const currency = await currencyUnits(d.currencyId);
    const rate = Number(d.rateToBase);
    const total = Number(d.baseTotalMinor);
    const tax = applyRate(Number(d.taxMinor), rate, currency.minorUnits, base.minorUnits);
    const sign = d.kind === 'credit_note' ? -1 : 1;
    const p = { date: new Date(d.date as string), journal: d.kind === 'credit_note' ? 'Credit note' : 'Invoice', document: String(d.number), party: await partyName(d.customerId), currency: currency.code, units: currency.minorUnits };
    line({ ...p, role: 'receivables', description: p.journal, amountMinor: sign * Number(d.totalMinor) }, sign * total);
    line({ ...p, role: 'revenue', description: 'Freight', amountMinor: -sign * Number(d.netMinor) }, -sign * (total - tax));
    line({ ...p, role: 'tax', description: String(d.taxLabel ?? 'Tax'), amountMinor: -sign * Number(d.taxMinor) }, -sign * tax);
  }

  // Payments: money in, the invoices settled at their booked value, and the difference as exchange gain or loss.
  for (const pay of await CustomerPayment.find({ date: between }).sort({ date: 1 }).lean() as Plain[]) {
    const amount = pay.amount as { amountMinor: number; currencyId: unknown };
    const currency = await currencyUnits(amount.currencyId);
    const p = { date: new Date(pay.date as string), journal: 'Payment received', document: String(pay.number), party: await partyName(pay.customerId), currency: currency.code, units: currency.minorUnits };
    line({ ...p, role: 'bank', description: pay.reference ? `Received (${pay.reference})` : 'Received', amountMinor: amount.amountMinor }, Number(pay.baseAmountMinor));
    let allocated = 0;
    for (const a of (pay.allocations ?? []) as Plain[]) {
      allocated += Number(a.receivedBaseMinor);
      line({ ...p, role: 'receivables', description: `Settles ${a.invoiceNumber}` }, -Number(a.bookedBaseMinor));
      const diff = Number(a.gainLossBaseMinor);
      if (diff) line({ ...p, role: diff > 0 ? 'exchange_gain' : 'exchange_loss', description: `Exchange ${diff > 0 ? 'gain' : 'loss'} on ${a.invoiceNumber}` }, -diff);
    }
    // Received and not yet set against an invoice: held for the customer.
    line({ ...p, role: 'receivables', description: 'On account' }, -(Number(pay.baseAmountMinor) - allocated));
  }

  // Revaluations and their reversals: what is owed revalued against the unrealised gain or loss.
  for (const e of await ExchangeDifference.find({ kind: { $in: ['unrealised', 'reversal'] }, date: between }).sort({ date: 1 }).lean() as Plain[]) {
    const inv = await Invoice.findById(e.invoiceId).select('number').lean() as Plain | null;
    const p = { date: new Date(e.date as string), journal: e.kind === 'reversal' ? 'Revaluation reversed' : 'Revaluation', document: String(inv?.number ?? ''), party: await partyName(e.customerId), currency: base.code };
    line({ ...p, role: 'receivables', description: p.journal }, Number(e.amountMinor));
    line({ ...p, role: 'unrealised_exchange', description: p.journal }, -Number(e.amountMinor));
  }

  // Cash advanced to drivers, and the expenses they spent it on.
  const driverName = async (id: unknown) => String((await Driver.findById(id).select('name').lean() as Plain | null)?.name ?? '');
  for (const r of await FundRequest.find({ kind: 'cash', status: 'issued', issuedAt: between }).sort({ issuedAt: 1 }).lean() as Plain[]) {
    const amount = r.amount as { amountMinor: number; currencyId: unknown } | undefined;
    const currency = amount ? await currencyUnits(amount.currencyId) : base;
    const trip = await Trip.findById(r.tripId).select('driverId').lean() as Plain | null;
    const p = { date: new Date(r.issuedAt as string), journal: 'Driver advance', document: String(r.number), party: await driverName(trip?.driverId), currency: currency.code, units: currency.minorUnits, amountMinor: amount?.amountMinor };
    line({ ...p, role: 'driver_advances', description: 'Cash advanced' }, Number(r.baseAmountMinor ?? 0));
    line({ ...p, role: 'bank', description: 'Cash advanced', amountMinor: amount ? -amount.amountMinor : undefined }, -Number(r.baseAmountMinor ?? 0));
  }
  for (const x of await Expense.find({ status: 'approved', decidedAt: between }).sort({ decidedAt: 1 }).lean() as Plain[]) {
    const amount = x.amount as { amountMinor: number; currencyId: unknown };
    const currency = await currencyUnits(amount.currencyId);
    const p = { date: new Date(x.decidedAt as string), journal: 'Expense', document: String(x.number), party: await driverName(x.driverId), currency: currency.code, units: currency.minorUnits };
    line({ ...p, role: 'expenses', description: x.receiptNo ? `Receipt ${x.receiptNo}` : 'Approved expense', amountMinor: amount.amountMinor }, Number(x.baseAmountMinor));
    line({ ...p, role: 'driver_advances', description: 'Spent from the advance', amountMinor: -amount.amountMinor }, -Number(x.baseAmountMinor));
  }
  return out.sort((a, b) => +a.date - +b.date);
}

const csvCell = (v: unknown) => {
  const s = v === undefined || v === null ? '' : String(v);
  // A cell starting with = + - @ would run as a formula in a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** The export as CSV, every line with its account code. Refused while a posting it needs has no account code. */
export async function exportCsv(range: { from: Date; to: Date }) {
  if (range.from > range.to) throw refuse('The export starts after it ends.');
  const base = await baseCurrency();
  const lines = await postings(range);
  const codes = await AccountCode.find({ status: 'active' }).select('code name postsFor').lean() as Plain[];
  const account = new Map<string, Plain>();
  for (const c of codes) for (const role of (c.postsFor ?? []) as string[]) account.set(role, c);
  const missing = [...new Set(lines.map((l) => l.role))].filter((r) => !account.has(r));
  if (missing.length) throw refuse(`Give an account code for: ${missing.map((r) => POSTING_LABELS[r]).join(', ')} (Masters → Account codes).`, { missing });
  const decimal = (minor: number) => (minor ? (minor / 10 ** base.minorUnits).toFixed(base.minorUnits) : '');
  const header = ['Date', 'Journal', 'Document', 'Customer or driver', 'Account code', 'Account', 'Details', `Debit (${base.code})`, `Credit (${base.code})`, 'Currency', 'Amount in currency'];
  const rows = lines.map((l) => {
    const a = account.get(l.role)!;
    return [l.date.toISOString().slice(0, 10), l.journal, l.document, l.party, a.code, a.name, l.description, decimal(l.debitMinor), decimal(l.creditMinor), l.currency, l.amountMinor === undefined ? '' : (l.amountMinor / 10 ** (l.units ?? 2)).toFixed(l.units ?? 2)];
  });
  const debit = lines.reduce((s, l) => s + l.debitMinor, 0);
  const credit = lines.reduce((s, l) => s + l.creditMinor, 0);
  return { csv: [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n', lines: lines.length, debitMinor: debit, creditMinor: credit };
}
