import { Types } from 'mongoose';
import { ForbiddenError, NotFoundError } from '../../core/errors/index.js';
import { mayDecideAll, routeApproval } from './approvals.js';
import type { Plain } from '../../core/masters/types.js';
import { Company } from '../company/company.model.js';
import { Driver } from '../drivers/models/driver.model.js';
import { driverLedger, sumOf } from './ledger.js';
import { Consignment, DriverDocument } from './models/cargo.model.js';
import { FundRequest } from './models/funding.model.js';
import { DriverAccount, Expense, Settlement } from './models/money.model.js';
import { TO_SETTLE, Trip } from './models/trip.model.js';
import { announce, moneyValues } from './notices.js';
import {
  activeDriver, baseCurrency, conflict, driverThread, formatMoney, log, need, nextNumber, post, present, queue, refuse, resolve, type OpsContext,
} from './support.js';
import type * as S from './operations.schema.js';

/* ---------- Driver accounts ---------- */

/** Every active driver with their balance, closed trips not yet settled and any open request to settle. */
export async function listAccounts() {
  const base = await baseCurrency();
  const drivers = await Driver.find({ status: { $ne: 'archived' } }).select('name code phone').sort({ name: 1 }).lean();
  const accounts = new Map((await DriverAccount.find().lean()).map((a) => [String(a.driverId), a]));
  const unsettled = await Trip.aggregate<{ _id: Types.ObjectId; n: number }>([
    { $match: { ...TO_SETTLE, driverId: { $exists: true } } },
    { $group: { _id: '$driverId', n: { $sum: 1 } } },
  ]);
  const unsettledBy = new Map(unsettled.map((u) => [String(u._id), u.n]));
  return Promise.all(drivers.map(async (d) => {
    const account = accounts.get(String(d._id));
    return {
      driverId: String(d._id), name: d.name, code: d.code, currency: base,
      balanceMinor: sumOf(await driverLedger(d._id)), unsettledTrips: unsettledBy.get(String(d._id)) ?? 0,
      settleRequestedAt: account?.settleRequestedAt ?? null, settleRequestedByDesk: account?.settleRequestedByDesk ?? null,
    };
  }));
}

export async function getAccount(driverId: string) {
  const driver = await Driver.findById(driverId).select('name').lean();
  if (!driver) throw new NotFoundError('Driver not found');
  const entries = await driverLedger(driverId);
  const account = await DriverAccount.findOne({ driverId }).lean();
  const trips = await Trip.find({ driverId, ...TO_SETTLE }).select('_id number').sort({ endedAt: 1, cancelledAt: 1 }).lean();
  return {
    driverId, name: driver.name, currency: await baseCurrency(), balanceMinor: sumOf(entries), entries,
    unsettledTrips: trips.map((t) => ({ id: String(t._id), number: t.number })), settleRequestedAt: account?.settleRequestedAt ?? null,
  };
}

/** Operations asks Finance to settle a driver. */
export async function requestSettlement(driverId: string, ctx: OpsContext) {
  need(ctx, 'settlement-requests', 'create');
  const at = new Date();
  const driver = await activeDriver(driverId);
  await DriverAccount.updateOne({ driverId: driver._id }, { $set: { settleRequestedAt: at, settleRequestedByDesk: ctx.desk, settleRequestedBy: ctx.actorId }, $inc: { version: 1 } }, { upsert: true });
  const trips = await Trip.countDocuments({ driverId: driver._id, ...TO_SETTLE });
  const base = await baseCurrency();
  await post(queue('settlements'), at, {
    title: `Settle ${driver.name}`,
    text: `${ctx.name} asks for a settlement: ${trips} closed trip${trips === 1 ? '' : 's'}, balance ${formatMoney(sumOf(await driverLedger(driver._id)), base)}.`,
    buttons: [{ label: 'Open statement', tone: 'primary', nav: { view: 'settle', driverId } }],
    refId: `${driverId}-settle`,
  }, ctx);
  await log(ctx, at, `Asked Finance to settle ${driver.name}`, { entity: 'drivers', entityId: driver._id });
  return getAccount(driverId);
}

/* ---------- Settlements ---------- */

export async function listSettlements(query: S.SettlementListQuery) {
  const filter: Plain = query.driverId ? { driverId: query.driverId } : {};
  const [rows, total] = await Promise.all([
    Settlement.find(filter).sort({ postedAt: -1, _id: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
    Settlement.countDocuments(filter),
  ]);
  return { data: rows.map(present), total, page: query.page, limit: query.limit };
}

export async function getSettlement(id: string) {
  const doc = await Settlement.findById(id).lean();
  if (!doc) throw new NotFoundError('Settlement not found');
  return present(doc);
}

/**
 * Settles any set of a driver's closed trips: freezes their ledger lines and the cash handed in or paid out.
 * Every expense, shortage and receipt on those trips must be decided first.
 */
export async function postSettlement(input: S.SettlementInput, ctx: OpsContext) {
  need(ctx, 'settlements', 'create', 'Finance posts settlements.');
  const at = new Date();
  const driver = await activeDriver(input.driverId);
  const base = await baseCurrency();
  const trips = await Trip.find({ _id: { $in: input.tripIds } }).lean();
  if (trips.length !== input.tripIds.length) throw new NotFoundError('Trip not found');
  for (const t of trips) {
    if (String(t.driverId) !== String(driver._id)) throw refuse(`${t.number} belongs to another driver.`);
    if (!t.endedAt && !t.settleAfterCancel) throw refuse(`${t.number} is still on the road.`);
    if (t.settlementId) throw conflict(`${t.number} is already settled.`);
    if (await Expense.exists({ tripId: t._id, status: 'pending' })) throw refuse(`Decide the expenses on ${t.number} first.`);
    if (await Consignment.exists({ tripId: t._id, 'shortage.status': 'pending' })) throw refuse(`Decide the fuel shortage on ${t.number} first.`);
    if (await DriverDocument.exists({ tripId: t._id, status: 'new', kind: { $in: ['expense', 'fuel'] } })) throw refuse(`There's an unchecked receipt on ${t.number}.`);
    if (await FundRequest.exists({ tripId: t._id, status: { $in: ['pending', 'owner', 'approved'] } })) throw refuse(`A money request on ${t.number} is still open.`);
  }
  const chosen = new Set(input.tripIds.map(String));
  const ledger = await driverLedger(driver._id);
  const selected = ledger.filter((e) => e.tripId && chosen.has(e.tripId) && !e.settlementId);
  const balance = sumOf(ledger);
  const selectedSum = sumOf(selected);
  const opening = balance - selectedSum;
  const before = opening + selectedSum;
  if (input.cashMinor > 0 && input.cashMinor > Math.max(0, before)) throw refuse(`${driver.name} holds ${formatMoney(Math.max(0, before), base)}. Not more can be returned.`);
  if (input.cashMinor < 0 && -input.cashMinor > Math.max(0, -before)) throw refuse(`The company owes ${formatMoney(Math.max(0, -before), base)}. Don't pay more.`);
  // With a settlement policy, posting is an approval: the poster must be its final approver for this amount.
  const approval = await routeApproval('settlement', { amountMinor: Math.abs(input.cashMinor), currencyId: base.id });
  if (!mayDecideAll(ctx, approval)) throw new ForbiddenError(`Posting this settlement needs ${approval.levels.at(-1)!.label}.`);
  const sumKind = (kind: string) => sumOf(selected.filter((e) => e.kind === kind));
  const starts = trips.map((t) => (t.dispatchedAt ?? t.createdAt) as Date).sort((a, b) => a.getTime() - b.getTime());
  const ends = trips.map((t) => (t.endedAt ?? t.cancelledAt) as Date).sort((a, b) => a.getTime() - b.getTime());
  const settlement = await Settlement.create({
    number: await nextNumber('settlements', 'SET', at), driverId: driver._id, tripIds: input.tripIds, from: starts[0], to: ends.at(-1),
    currencyId: base.id, openingMinor: opening, advancesMinor: sumKind('advance'), expensesMinor: -sumKind('expense'), shortagesMinor: sumKind('shortage'),
    cashMinor: input.cashMinor, closingMinor: before - input.cashMinor, note: input.note, postedAt: at, createdBy: ctx.actorId, updatedBy: ctx.actorId,
  });
  // No multi-document transactions: claim each trip only if it is still unsettled, and undo if another settlement got there first.
  const claimed = await Trip.updateMany({ _id: { $in: input.tripIds }, settlementId: { $exists: false } }, { $set: { settlementId: settlement._id, updatedBy: ctx.actorId }, $inc: { version: 1 } });
  if (claimed.modifiedCount !== input.tripIds.length) {
    await Trip.updateMany({ settlementId: settlement._id }, { $unset: { settlementId: 1 }, $inc: { version: 1 } });
    await Settlement.deleteOne({ _id: settlement._id });
    throw conflict('Some of these trips were settled by someone else. Reload and try again.');
  }
  await DriverAccount.updateOne({ driverId: driver._id }, { $unset: { settleRequestedAt: 1, settleRequestedByDesk: 1, settleRequestedBy: 1 }, $inc: { version: 1 } });
  await resolve(`${driver._id}-settle`, `Settled · ${settlement.get('number')}`);
  const s = settlement.toObject() as Plain;
  const money = (minor: number) => formatMoney(minor, base);
  const closing = Number(s.closingMinor), cash = Number(s.cashMinor);
  const carry = closing ? `${money(Math.abs(closing))} carries forward.` : 'Your account is clear.';
  await post(driverThread(driver._id), at, {
    title: `Settlement ${s.number}`,
    text: cash > 0 ? `You returned ${money(cash)}. ${carry}` : cash < 0 ? `${money(-cash)} paid to you. ${carry}` : `${money(Math.abs(closing))} carries forward${closing < 0 ? ' in your favour' : ''}.`,
    rows: [
      ['Trips', trips.map((t) => t.number).join(', ')], ['Advances', money(Number(s.advancesMinor))], ['Approved expenses', money(Number(s.expensesMinor))],
      ...(Number(s.shortagesMinor) ? [['Fuel shortage', money(Number(s.shortagesMinor))] as [string, string]] : []),
    ],
    buttons: [{ label: 'View statement', nav: { view: 'statement', driverId: String(driver._id) } }],
  }, ctx);
  await post(queue('trips'), at, { title: `${driver.name} settled`, text: `${s.number} covers ${trips.length} trip${trips.length === 1 ? '' : 's'}. Trip sheets are final.` }, ctx);
  await log(ctx, at, `Settled ${driver.name}: ${s.number}, ${trips.length} trips, carry forward ${money(closing)}`, { entity: 'settlements', entityId: settlement._id });
  for (const t of trips) await log(ctx, at, `Settled in ${s.number}`, { tripId: t._id });
  await announce('settlement.posted', null, ctx, {
    driverId: driver._id,
    variables: { ...(await moneyValues({ amountMinor: closing, currencyId: base.id })), 'trip.number': trips.map((t) => t.number).join(', '), 'document.number': String(s.number) },
    ref: { kind: 'settlements', id: settlement._id },
    // The driver statement goes with the e-mails; it is only made when one is going to someone.
    attachments: async () => {
      const { printoutFile } = await import('./printouts.js');
      const file = await printoutFile('driver_statement', String(settlement._id), ctx.actorId);
      return file ? [file] : null;
    },
  });
  return present(s);
}

/** Everything the printed driver statement shows. */
export async function statement(id: string) {
  const settlement = await Settlement.findById(id).lean();
  if (!settlement) throw new NotFoundError('Settlement not found');
  const [driver, trips, company] = await Promise.all([
    Driver.findById(settlement.driverId).select('name code phone licence.number').lean(),
    Trip.find({ _id: { $in: settlement.tripIds } }).select('number stops dispatchedAt endedAt vehicleId').lean(),
    Company.findOne().select('legalName tradingName address phone email').lean(),
  ]);
  const ids = new Set((settlement.tripIds as unknown[]).map(String));
  const lines = (await driverLedger(settlement.driverId)).filter((e) => (e.tripId && ids.has(e.tripId)) || e.settlementId === String(settlement._id));
  return { settlement: present(settlement), driver: driver ? present(driver) : null, trips: trips.map(present), lines, company: company ? present(company) : null, currency: await baseCurrency() };
}
