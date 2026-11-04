import type { Plain } from '../../../core/masters/types.js';
import { Company } from '../../company/company.model.js';
import { baseCurrency, conflict, log, refuse, type OpsContext } from '../../operations/support.js';
import { applyRate } from '../finance.service.js';
import { companyDay } from '../rateFeed.service.js';
import { billingSettings } from '../settings.service.js';
import { CustomerPayment, ExchangeDifference, Invoice, RevaluationRun } from './billing.model.js';
import { currencyUnits, rateOrRefuse } from './pricing.js';

/**
 * Revaluation of open foreign-currency invoices (#62). At a month's or quarter's end, by Money settings (off
 * by default), each invoice still owed in another currency is valued at that day's rate. The difference from
 * what it is booked at is an unrealised exchange gain or loss. The next run first reverses the last run's
 * entries, so the accounts only ever hold the latest valuation. What is booked on the invoice never changes:
 * the realised gain or loss on its payments is still measured from the invoice's own rate.
 */

const DAY = 86_400_000;
const utcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** The last period end on or before `today`: the month's or quarter's last day. */
export function lastPeriodEnd(today: Date, every: 'monthly' | 'quarterly'): Date {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const endOf = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0));
  if (every === 'monthly') {
    const thisEnd = endOf(y, m);
    return +thisEnd === +utcDay(today) ? thisEnd : endOf(y, m - 1);
  }
  const quarterEndMonth = Math.floor(m / 3) * 3 + 2;
  const thisEnd = endOf(y, quarterEndMonth);
  return +thisEnd === +utcDay(today) ? thisEnd : endOf(y, quarterEndMonth - 3);
}

async function today() {
  const company = await Company.findOne().select('timezone').lean<{ timezone?: string }>();
  return companyDay(new Date(), company?.timezone ?? 'UTC');
}

/** Whether the scheduled run has work: revaluation is on and the last period end has no run yet. */
export async function revaluationDue() {
  const { isBillingOn } = await import('./billing.masters.js');
  if (!(await isBillingOn())) return { due: false, reason: 'Billing is off' } as const;
  const { revaluation } = await billingSettings();
  if (revaluation === 'off') return { due: false, reason: 'Revaluation is off (Money settings)' } as const;
  const periodEnd = lastPeriodEnd(await today(), revaluation);
  if (await RevaluationRun.exists({ periodEnd })) return { due: false, reason: `${periodEnd.toISOString().slice(0, 10)} is revalued already`, periodEnd } as const;
  return { due: true, reason: 'Due', periodEnd } as const;
}

/** What an invoice owed at the end of `day`: today's open amount plus what was paid or credited after it. */
async function openOn(invoice: Plain, day: Date) {
  const after = new Date(day.getTime() + DAY);
  let open = Number(invoice.openMinor);
  let baseOpen = Number(invoice.baseOpenMinor);
  const payments = await CustomerPayment.find({ 'allocations.invoiceId': invoice._id, date: { $gte: after } }).select('allocations').lean() as Plain[];
  for (const p of payments) {
    for (const a of (p.allocations ?? []) as Plain[]) {
      if (String(a.invoiceId) !== String(invoice._id)) continue;
      open += Number(a.settledMinor);
      baseOpen += Number(a.bookedBaseMinor);
    }
  }
  const credits = await Invoice.find({ kind: 'credit_note', invoiceId: invoice._id, status: 'approved', date: { $gte: after } }).select('totalMinor baseTotalMinor').lean() as Plain[];
  for (const c of credits) { open += Number(c.totalMinor); baseOpen += Number(c.baseTotalMinor); }
  return { open, baseOpen };
}

/**
 * Revalues every open foreign-currency invoice at `periodEnd` (by default the last month's or quarter's end),
 * after reversing the run before it. One run per period end.
 */
export async function revalue(options: { periodEnd?: Date; trigger: 'schedule' | 'manual' }, ctx: OpsContext) {
  const settings = await billingSettings();
  if (!options.periodEnd && settings.revaluation === 'off') throw refuse('Revaluation is off. Choose monthly or quarterly in Money settings, or give the day to revalue at.');
  const periodEnd = utcDay(options.periodEnd ?? lastPeriodEnd(await today(), settings.revaluation === 'off' ? 'monthly' : settings.revaluation));
  if (await RevaluationRun.exists({ periodEnd })) throw conflict(`${periodEnd.toISOString().slice(0, 10)} is revalued already.`);
  if (await RevaluationRun.exists({ periodEnd: { $gt: periodEnd } })) throw conflict('A later period end is revalued already.');
  const base = await baseCurrency();
  const run = await RevaluationRun.create({ periodEnd, at: new Date(), trigger: options.trigger, createdBy: ctx.actorId });
  try {
    // Reverse the last run, the day after its period end.
    const previous = await RevaluationRun.findOne({ periodEnd: { $lt: periodEnd } }).sort({ periodEnd: -1 }).lean() as Plain | null;
    let reversedMinor = 0;
    if (previous) {
      const entries = await ExchangeDifference.find({ runId: previous._id, kind: 'unrealised' }).lean() as Plain[];
      const reversalDay = new Date(new Date(previous.periodEnd as string).getTime() + DAY);
      if (entries.length) {
        await ExchangeDifference.insertMany(entries.map((e) => ({
          kind: 'reversal', date: reversalDay, customerId: e.customerId, invoiceId: e.invoiceId, currencyId: e.currencyId, baseCurrencyId: e.baseCurrencyId,
          amountMinor: -Number(e.amountMinor), bookedRate: e.bookedRate, actualRate: e.actualRate, runId: run._id, reversesId: e._id, createdBy: ctx.actorId,
        })));
      }
      reversedMinor = -entries.reduce((s, e) => s + Number(e.amountMinor), 0);
    }

    const invoices = await Invoice.find({ kind: 'invoice', status: 'approved', currencyId: { $ne: base.id }, date: { $lte: periodEnd } }).lean() as Plain[];
    const missing = new Set<string>();
    const entries: Plain[] = [];
    for (const inv of invoices) {
      const { open, baseOpen } = await openOn(inv, periodEnd);
      if (open <= 0) continue;
      const currency = await currencyUnits(inv.currencyId);
      let rate: number;
      try { rate = await rateOrRefuse(currency.id, base.id, periodEnd); } catch { missing.add(currency.code); continue; }
      const amountMinor = applyRate(open, rate, currency.minorUnits, base.minorUnits) - baseOpen;
      if (!amountMinor) continue;
      entries.push({
        kind: 'unrealised', date: periodEnd, customerId: inv.customerId, invoiceId: inv._id, currencyId: inv.currencyId, baseCurrencyId: base.id,
        amountMinor, bookedRate: inv.rateToBase, actualRate: rate, runId: run._id, createdBy: ctx.actorId,
      });
    }
    if (entries.length) await ExchangeDifference.insertMany(entries);
    const netMinor = entries.reduce((s, e) => s + Number(e.amountMinor), 0);
    await RevaluationRun.updateOne({ _id: run._id }, { $set: { invoices: entries.length, netMinor, reversedMinor, reversedRunId: previous?._id, missing: [...missing] } });
    await log(ctx, new Date(), `Open invoices revalued at ${periodEnd.toISOString().slice(0, 10)}: ${entries.length} invoice${entries.length === 1 ? '' : 's'}`, { entity: 'revaluations', entityId: run._id });
  } catch (err) {
    // A run that fails leaves nothing behind, so it can simply be run again.
    await ExchangeDifference.deleteMany({ runId: run._id });
    await RevaluationRun.deleteOne({ _id: run._id });
    throw err;
  }
  return presentRun(await RevaluationRun.findById(run._id).lean() as Plain);
}

export interface RunView { id: string; periodEnd: Date; at: Date; trigger: string; invoices: number; netMinor: number; reversedMinor: number; missing: string[] }
const presentRun = ({ _id, ...r }: Plain): RunView => ({ ...(r as Omit<RunView, 'id'>), id: String(_id) });

export async function listRuns() {
  const runs = await RevaluationRun.find().sort({ periodEnd: -1 }).limit(24).lean() as Plain[];
  return runs.map(presentRun);
}
