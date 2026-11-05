import { Types } from 'mongoose';
import * as Fmt from '../../core/format/regional.js';
import type { Plain } from '../../core/masters/types.js';
import { Driver } from '../drivers/models/driver.model.js';
import { ExpenseCategory } from '../trips/models/expense.model.js';
import { Consignment } from './models/cargo.model.js';
import { FundRequest } from './models/funding.model.js';
import { Expense, Settlement } from './models/money.model.js';
import { Trip } from './models/trip.model.js';
import { toBase } from './support.js';

export interface LedgerEntry {
  id: string;
  at: string;
  tripId?: string;
  settlementId?: string;
  kind: 'opening' | 'advance' | 'expense' | 'shortage' | 'write_off' | 'cash';
  label: string;
  /** Base-currency minor units. Positive: the driver holds company money. */
  amountMinor: number;
}

const OPENING_AT = '2000-01-01T00:00:00.000Z';

/**
 * A driver's cash account in the base currency. Advances paid and shortages charged add to what the
 * driver holds; approved expenses and cash settled reduce it. A negative balance means the company owes the driver.
 */
export async function driverLedger(driverId: unknown): Promise<LedgerEntry[]> {
  const id = new Types.ObjectId(String(driverId));
  const [driver, trips] = await Promise.all([
    Driver.findById(id).select('openingBalance').lean(),
    Trip.find({ driverId: id }).select('_id number settlementId').lean(),
  ]);
  const tripById = new Map(trips.map((t) => [String(t._id), t]));
  const tripIds = trips.map((t) => t._id);
  const entries: LedgerEntry[] = [];
  const opening = driver?.openingBalance as { amountMinor: number; currencyId: unknown } | undefined;
  if (opening?.amountMinor) {
    entries.push({ id: `open-${id}`, at: OPENING_AT, kind: 'opening', label: 'Carried in', amountMinor: (await toBase(opening.amountMinor, opening.currencyId)).baseMinor, settlementId: 'opening' });
  }
  const [advances, expenses, shortages, writeOffs, settlements] = await Promise.all([
    FundRequest.find({ tripId: { $in: tripIds }, kind: 'cash', status: 'issued' }).lean(),
    Expense.find({ driverId: id, status: 'approved' }).lean(),
    Consignment.find({ tripId: { $in: tripIds }, 'shortage.status': 'charged' }).lean(),
    // A load written off and carried by the driver is recovered through their account (#64).
    Consignment.find({ tripId: { $in: tripIds }, 'writeOff.status': 'approved', 'writeOff.carrier': 'driver' }).lean(),
    Settlement.find({ driverId: id, cashMinor: { $ne: 0 } }).lean(),
  ]);
  const categories = new Map((await ExpenseCategory.find({ _id: { $in: expenses.map((e) => e.categoryId) } }).select('name').lean()).map((c) => [String(c._id), String(c.name)]));
  const settlementOf = (tripId: unknown) => {
    const s = tripById.get(String(tripId))?.settlementId;
    return s ? String(s) : undefined;
  };
  for (const r of advances) {
    entries.push({ id: String(r._id), at: (r.issuedAt as Date).toISOString(), tripId: String(r.tripId), settlementId: settlementOf(r.tripId), kind: 'advance', label: `Advance ${r.number}`, amountMinor: Number(r.baseAmountMinor ?? 0) });
  }
  for (const e of expenses) {
    entries.push({
      id: String(e._id), at: (e.at as Date).toISOString(), tripId: e.tripId ? String(e.tripId) : undefined, settlementId: e.tripId ? settlementOf(e.tripId) : undefined,
      kind: 'expense', label: `${categories.get(String(e.categoryId)) ?? 'Expense'} ${e.receiptNo ?? ''}`.trim(), amountMinor: -Number(e.baseAmountMinor),
    });
  }
  for (const c of shortages) {
    const s = c.shortage as Plain;
    entries.push({
      id: `short-${c._id}`, at: (s.decidedAt as Date).toISOString(), tripId: String(c.tripId), settlementId: settlementOf(c.tripId),
      kind: 'shortage', label: `${s.unit && s.unit !== 'L' ? 'Shortage' : 'Fuel shortage'} ${c.number} · ${Fmt.number(Number(s.netShortL), { max: 2 })} ${s.unit ?? 'L'}`, amountMinor: Number(s.baseAmountMinor ?? 0),
    });
  }
  for (const c of writeOffs) {
    const w = c.writeOff as Plain;
    entries.push({ id: `writeoff-${c._id}`, at: (w.decidedAt as Date).toISOString(), tripId: String(c.tripId), settlementId: settlementOf(c.tripId), kind: 'write_off', label: `Load written off ${c.number}`, amountMinor: Number(w.baseAmountMinor) });
  }
  for (const s of settlements) {
    const cash = Number(s.cashMinor);
    entries.push({ id: `cash-${s._id}`, at: (s.postedAt as Date).toISOString(), settlementId: String(s._id), kind: 'cash', label: cash > 0 ? `Cash returned · ${s.number}` : `Paid to driver · ${s.number}`, amountMinor: -cash });
  }
  return entries.sort((a, b) => a.at.localeCompare(b.at));
}

export const sumOf = (entries: LedgerEntry[]) => entries.reduce((s, e) => s + e.amountMinor, 0);

export async function driverBalance(driverId: unknown) {
  return sumOf(await driverLedger(driverId));
}

/** What the driver carries into a trip: everything on the account not produced by this trip. */
export async function carriedIn(driverId: unknown, tripId: unknown) {
  return sumOf((await driverLedger(driverId)).filter((e) => e.tripId !== String(tripId)));
}
