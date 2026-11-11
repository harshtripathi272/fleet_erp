import { Types } from 'mongoose';
import * as Fmt from '../../../core/format/regional.js';
import { NotFoundError } from '../../../core/errors/index.js';
import type { Plain } from '../../../core/masters/types.js';
import { Currency } from '../../finance/models/currency.model.js';
import { ExpenseCategory } from '../../trips/models/expense.model.js';
import { Vehicle } from '../../fleet/models/vehicle.model.js';
import { Consignment } from '../../operations/models/cargo.model.js';
import { FundRequest } from '../../operations/models/funding.model.js';
import { Expense } from '../../operations/models/money.model.js';
import { Trip } from '../../operations/models/trip.model.js';
import { baseCurrency, refuse, toBase, type OpsContext } from '../../operations/support.js';
import { ChargeType, FuelPrice } from '../models/freight.model.js';
import { freightSettings } from '../settings.js';

/**
 * Trip profit (#135, consignments design 3.6): the revenue of the consignments the trip carried less what the trip
 * cost, in the base currency, every figure with the records it comes from. Worked out on read; a snapshot is kept on
 * the trip (`trip.profit`) for lists. Written by lakshya-t3 while the builder was paused, to the API contract's
 * section 6 shape.
 *
 * One reading of 3.6.2 to note: a shortage the customer deducted already lowers revenue, so a shortage waived for
 * the driver adds no further cost; one charged to the driver comes back as "recovered". Write-offs are a loss to
 * the company, and a driver's share of one is recovered.
 */

export type ProfitGroup = 'fuel' | 'expenses' | 'charges' | 'losses' | 'recovered' | 'other' | 'overhead';
interface Item { ref: string; label: string; amountMinor: number }
interface CostGroup { group: ProfitGroup; label: string; amountMinor: number; items: Item[]; litres?: { opening: number; issued: number; closing: number; used: number } }

const id = (v: unknown) => String(v);
const DAY = 86_400_000;

async function unitsOf(currencyId: unknown) {
  const c = await Currency.findById(currencyId).select('code minorUnits').lean<Plain>();
  return { code: String(c?.code ?? ''), minorUnits: Number(c?.minorUnits ?? 2) };
}

/** A revenue line's amount in the base currency, at the rate the revenue was priced at. */
function lineToBase(amountMinor: number, revenue: Plain, from: { minorUnits: number }, base: { minorUnits: number }) {
  const rate = Number(revenue.rateToBase ?? 0);
  return rate ? Math.round((amountMinor / 10 ** from.minorUnits) * rate * 10 ** base.minorUnits) : undefined;
}

export async function tripProfit(tripId: string) {
  const trip = await Trip.findById(tripId).lean<Plain>();
  if (!trip) throw new NotFoundError('Trip not found');
  const [base, settings] = await Promise.all([baseCurrency(), freightSettings()]);
  const counts = new Set(settings.profitCosts as string[]);
  const money = (minor: number) => Fmt.money(minor, base);
  const warnings: string[] = [];
  let complete = true;

  /* ---------- Revenue (3.6.1) ---------- */
  const consignments = await Consignment.find({ $or: [{ tripId: trip._id }, { 'movements.tripId': trip._id }], status: { $ne: 'cancelled' } }).lean<Plain[]>();
  const costTypes = new Set((await ChargeType.find({ direction: 'cost' }).select('_id').lean()).map((t) => id(t._id)));
  const revenue: Array<Plain> = [];
  const costCharges: Item[] = [];
  for (const c of consignments) {
    const moves = (c.movements ?? []) as Plain[];
    const delivering = id(c.tripId) === id(trip._id);
    const first = moves.length ? id(moves[0]!.tripId) === id(trip._id) : delivering;
    const ours = settings.transferRevenueSplit === 'first_trip' ? first : delivering;
    const r = (c.revenue ?? {}) as Plain;
    const status = String(r.status ?? 'unpriced');
    if (!ours) {
      const other = await Trip.findById(settings.transferRevenueSplit === 'first_trip' ? moves[0]?.tripId : c.tripId).select('number').lean<Plain>();
      revenue.push({ consignmentId: id(c._id), number: c.number, status, amountMinor: 0, counted: false, note: `Moved to ${other?.number ?? 'another trip'}: revenue counted there.` });
      continue;
    }
    if (status === 'unpriced') {
      warnings.push(`${c.number} has no price yet.`);
      complete = false;
    }
    const amount = status === 'unpriced' ? 0 : Number(r.baseSubtotalMinor ?? NaN);
    if (status !== 'unpriced' && Number.isNaN(amount)) {
      warnings.push(`${c.number} is priced in another currency with no exchange rate on its pricing day, so it isn't counted.`);
      complete = false;
    }
    revenue.push({ consignmentId: id(c._id), number: c.number, customerId: c.customerId, status, amountMinor: Number.isNaN(amount) ? 0 : amount, counted: true, note: status === 'estimated' ? 'An estimate until every pickup and drop is recorded.' : null });
    // Cost-direction lines on the revenue (a broker's commission) are this trip's cost.
    const units = r.currencyId ? await unitsOf(r.currencyId) : { minorUnits: base.minorUnits };
    for (const l of (r.lines ?? []) as Plain[]) {
      if (l.accepted === false || !costTypes.has(id(l.chargeTypeId))) continue;
      const inBase = lineToBase(Number(l.amountMinor), r, units, base);
      if (inBase === undefined) continue;
      costCharges.push({ ref: `consignments:${id(c._id)}`, label: `${c.number} · ${String(l.description)}`, amountMinor: inBase });
    }
  }
  const revenueMinor = revenue.reduce((s, r) => s + Number(r.amountMinor), 0);
  for (const r of revenue) r.share = revenueMinor ? Math.round((Number(r.amountMinor) / revenueMinor) * 1000) / 10 : 0;

  /* ---------- Costs (3.6.2) ---------- */
  const costs: CostGroup[] = [];

  // Fuel: opening + issued − closing, at the price typed at the issue, else the fuel price list, else the company's default.
  const issues = await FundRequest.find({ tripId: trip._id, kind: 'fuel', status: 'issued' }).sort({ issuedAt: 1 }).lean<Plain[]>();
  const opening = Number(trip.openingFuelL ?? 0);
  const issued = issues.reduce((s, f) => s + Number(f.litres ?? 0), 0);
  const ended = Boolean(trip.endedAt);
  const closing = ended ? Number(trip.closingFuelL ?? 0) : 0;
  const used = Math.max(0, opening + issued - closing);
  const vehicle = await Vehicle.findById(trip.vehicleId).select('fuelTypeId').lean<Plain>();
  const listed = await FuelPrice.findOne({ status: 'active', ...(vehicle?.fuelTypeId ? { $or: [{ fuelTypeId: vehicle.fuelTypeId }, { fuelTypeId: { $exists: false } }] } : {}) }).sort({ fuelTypeId: -1, validFrom: -1 }).lean<Plain>();
  const listedBase = listed?.pricePerL ? (await toBase(Number((listed.pricePerL as Plain).amountMinor), (listed.pricePerL as Plain).currencyId)).baseMinor : undefined;
  const fallback = listedBase ?? (settings.defaultFuelPricePerLMinor ?? undefined);
  if (counts.has('fuel')) {
    const items: Item[] = [];
    let fuelMinor = 0;
    let unpricedL = 0;
    for (const f of issues) {
      const litres = Number(f.litres ?? 0);
      const price = f.unitPrice ? (await toBase(Number((f.unitPrice as Plain).amountMinor), (f.unitPrice as Plain).currencyId)).baseMinor : fallback;
      if (price === undefined) { unpricedL += litres; continue; }
      const amount = Math.round(litres * price);
      fuelMinor += amount;
      items.push({ ref: `fund-requests:${id(f._id)}`, label: `${String(f.number)} · ${Fmt.number(litres)} L at ${money(price)}${f.unitPrice ? '' : listed ? ` (${String(listed.name)})` : " (the company's default)"}`, amountMinor: amount });
    }
    // The fuel in the tank at the start, less what is left at the end, at the list or default price.
    const tankL = opening - closing;
    if (tankL !== 0) {
      if (fallback === undefined) unpricedL += Math.max(0, tankL);
      else {
        const amount = Math.round(tankL * fallback);
        fuelMinor += amount;
        items.push({ ref: 'price-list', label: `${Fmt.number(tankL)} L ${tankL > 0 ? 'from the tank' : 'back in the tank'} at ${money(fallback)}`, amountMinor: amount });
      }
    }
    if (unpricedL > 0) {
      warnings.push(`${Fmt.number(unpricedL)} L of fuel has no price: set one when issuing fuel, under Fuel prices, or as the company's default under Freight.`);
      complete = false;
    }
    if (fallback !== undefined && !listed && issues.some((f) => !f.unitPrice)) warnings.push(`Fuel is priced at the company's default ${money(fallback)} per litre.`);
    costs.push({ group: 'fuel', label: 'Fuel', amountMinor: fuelMinor, items, litres: { opening, issued, closing, used } });
  }

  // Approved expenses by category; pending ones are listed but not counted.
  const expenses = await Expense.find({ tripId: trip._id, status: { $in: ['approved', 'pending'] } }).lean<Plain[]>();
  const categories = new Map((await ExpenseCategory.find({ _id: { $in: expenses.map((e) => e.categoryId) } }).select('name').lean()).map((c) => [id(c._id), String((c as Plain).name)] as const));
  const pending = expenses.filter((e) => e.status === 'pending').map((e) => ({ ref: `expenses:${id(e._id)}`, label: categories.get(id(e.categoryId)) ?? 'Expense', amountMinor: Number(e.baseAmountMinor) }));
  if (counts.has('expenses')) {
    const approved = expenses.filter((e) => e.status === 'approved');
    const byCategory = new Map<string, Item[]>();
    for (const e of approved) {
      const name = categories.get(id(e.categoryId)) ?? 'Expenses';
      byCategory.set(name, [...(byCategory.get(name) ?? []), { ref: `expenses:${id(e._id)}`, label: `${name}${e.receiptNo ? ` · ${String(e.receiptNo)}` : ''}`, amountMinor: Number(e.baseAmountMinor) }]);
    }
    for (const [name, items] of byCategory) costs.push({ group: 'expenses', label: name, amountMinor: items.reduce((s, i) => s + i.amountMinor, 0), items });
  }
  if (pending.length) complete = false;

  if (counts.has('charges')) costs.push({ group: 'charges', label: 'Cost charges', amountMinor: costCharges.reduce((s, i) => s + i.amountMinor, 0), items: costCharges });

  // Losses carried by the company, and what the driver pays back.
  const losses: Item[] = [];
  const recovered: Item[] = [];
  for (const c of consignments.filter((x) => id(x.tripId) === id(trip._id))) {
    const shortage = c.shortage as Plain | undefined;
    if (shortage?.status === 'charged' && Number(shortage.baseAmountMinor)) recovered.push({ ref: `consignments:${id(c._id)}`, label: `${c.number} · shortage charged to the driver`, amountMinor: -Number(shortage.baseAmountMinor) });
    if (shortage?.status === 'pending') complete = false;
    const w = ((c.outcome as Plain | undefined)?.writeOff ?? c.writeOff) as Plain | undefined;
    if (w?.status === 'approved') {
      losses.push({ ref: `consignments:${id(c._id)}`, label: `${c.number} · written off`, amountMinor: Number(w.baseAmountMinor ?? 0) });
      if (w.carrier === 'driver') recovered.push({ ref: `consignments:${id(c._id)}`, label: `${c.number} · write-off carried by the driver`, amountMinor: -Number(w.baseAmountMinor ?? 0) });
    }
    if (w?.status === 'pending') complete = false;
  }
  if (counts.has('losses')) costs.push({ group: 'losses', label: 'Losses carried by the company', amountMinor: losses.reduce((s, i) => s + i.amountMinor, 0), items: losses });
  if (counts.has('recovered')) costs.push({ group: 'recovered', label: 'Recovered from the driver', amountMinor: recovered.reduce((s, i) => s + i.amountMinor, 0), items: recovered });

  if (counts.has('other')) {
    const lines = ((trip.costLines ?? []) as Plain[]).map((l) => ({ ref: `costs:${id(l._id)}`, label: `${String(l.label)}${l.note ? ` · ${String(l.note)}` : ''}`, amountMinor: Number(l.baseAmountMinor) }));
    costs.push({ group: 'other', label: 'Other costs', amountMinor: lines.reduce((s, i) => s + i.amountMinor, 0), items: lines });
  }

  /* ---------- The result (3.6.3) ---------- */
  const costMinor = costs.reduce((s, c) => s + c.amountMinor, 0);
  const profitMinor = revenueMinor - costMinor;
  const stops = (trip.stops ?? []) as Plain[];
  const km = Math.round(stops.reduce((s, x) => s + Number(x.legKm ?? 0), 0));
  const firstLoad = stops.findIndex((s) => s.kind === 'load');
  const lastDrop = stops.map((s) => s.kind).lastIndexOf('offload');
  const loadedKm = firstLoad >= 0 && lastDrop > firstLoad ? Math.round(stops.slice(firstLoad + 1, lastDrop + 1).reduce((s, x) => s + Number(x.legKm ?? 0), 0)) : 0;
  const start = trip.dispatchedAt ? new Date(trip.dispatchedAt as string) : undefined;
  const days = start ? Math.max(1, Math.ceil(((trip.endedAt ? new Date(trip.endedAt as string) : new Date()).getTime() - start.getTime()) / DAY)) : 0;
  const allFrozen = consignments.every((c) => ['frozen', 'invoiced'].includes(String((c.revenue as Plain | undefined)?.status)));
  const status = !ended ? 'estimate' : trip.settlementId && allFrozen && complete ? 'final' : 'provisional';
  const cashBudget = trip.cashBudget ? (await toBase(Number((trip.cashBudget as Plain).amountMinor ?? 0), (trip.cashBudget as Plain).currencyId)).baseMinor : 0;
  const result = {
    status, complete, currency: base,
    revenueMinor, costMinor, profitMinor,
    marginPercent: revenueMinor ? Math.round((profitMinor / revenueMinor) * 1000) / 10 : null,
    perKm: km ? Math.round(profitMinor / km) : null, perLoadedKm: loadedKm ? Math.round(profitMinor / loadedKm) : null, perDay: days ? Math.round(profitMinor / days) : null,
    km, loadedKm, days,
    revenue: await withCustomers(revenue),
    costs, pending,
    budget: { fuelL: Number(trip.fuelBudgetL ?? 0), cashMinor: cashBudget, usedFuelL: issued, usedCashMinor: expenses.filter((e) => e.status === 'approved').reduce((s, e) => s + Number(e.baseAmountMinor), 0) },
    warnings,
  };
  await Trip.updateOne({ _id: trip._id }, { $set: { profit: { status, revenueMinor, costMinor, profitMinor, complete, at: new Date() } } });
  return result;
}

async function withCustomers(rows: Plain[]) {
  const { Party } = await import('../../parties/models/party.model.js');
  const ids = rows.map((r) => r.customerId).filter(Boolean);
  const names = new Map((await Party.find({ _id: { $in: ids } }).select('name').lean()).map((p) => [id(p._id), String((p as Plain).name)] as const));
  return rows.map(({ customerId, ...r }) => ({ ...r, customer: customerId ? names.get(id(customerId)) : undefined }));
}

/** Keeps the trip's profit snapshot current after an event that changes a figure. Never fails the event itself. */
export async function refreshProfit(tripId: string): Promise<void> {
  try { await tripProfit(tripId); } catch { /* a trip with no base currency yet has no profit to keep */ }
}

/** POST /trips/:id/costs: a cost the system doesn't track, typed on the trip. */
export async function addCost(tripId: string, input: { chargeTypeId?: string; label: string; amount: { amountMinor: number; currencyId: string }; note?: string }, ctx: OpsContext) {
  const trip = await Trip.findById(tripId).select('_id').lean();
  if (!trip) throw new NotFoundError('Trip not found');
  if (input.chargeTypeId && !(await ChargeType.exists({ _id: input.chargeTypeId, direction: 'cost' }))) throw refuse('Choose a charge type that is a cost, or none.');
  const { baseMinor } = await toBase(input.amount.amountMinor, input.amount.currencyId);
  await Trip.updateOne({ _id: trip._id }, { $push: { costLines: {
    _id: new Types.ObjectId(), ...(input.chargeTypeId ? { chargeTypeId: input.chargeTypeId } : {}), label: input.label, amount: input.amount,
    baseAmountMinor: baseMinor, ...(input.note ? { note: input.note } : {}), at: new Date(), ...(ctx.actorId ? { by: ctx.actorId } : {}), byName: ctx.name,
  } } });
  return tripProfit(tripId);
}

/** DELETE /trips/:id/costs/:lineId. */
export async function removeCost(tripId: string, lineId: string) {
  const res = await Trip.updateOne({ _id: tripId }, { $pull: { costLines: { _id: new Types.ObjectId(lineId) } } });
  if (!res.matchedCount) throw new NotFoundError('Trip not found');
  return tripProfit(tripId);
}
