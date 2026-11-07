import { NotFoundError } from '../../core/errors/index.js';
import type { Plain } from '../../core/masters/types.js';
import { Company } from '../company/company.model.js';
import { Driver } from '../drivers/models/driver.model.js';
import { Vehicle } from '../fleet/models/vehicle.model.js';
import { driverLedger, sumOf } from './ledger.js';
import { Consignment, DriverDocument } from './models/cargo.model.js';
import { FundRequest, VehicleState } from './models/funding.model.js';
import { Message, Activity, ThreadRead } from './models/message.model.js';
import { DriverAccount, Expense, Nomination, Settlement } from './models/money.model.js';
import { TO_SETTLE, Trip } from './models/trip.model.js';
import { baseCurrency, present } from './support.js';
import { presentTrip } from './trips.service.js';
import { threadFilter, type Viewer } from './messages.service.js';

/** Drivers holding company cash (positive balance) or owed by the company (negative). */
async function balances() {
  const drivers = await Driver.find({ status: 'active' }).select('name').lean();
  const rows = await Promise.all(drivers.map(async (d) => ({ driverId: String(d._id), name: String(d.name), balanceMinor: sumOf(await driverLedger(d._id)) })));
  return rows.filter((r) => r.balanceMinor !== 0).sort((a, b) => b.balanceMinor - a.balanceMinor);
}

/** The owner's overview: what needs the owner, the fleet now, trips by state, latest activity. */
export async function ownerDashboard() {
  const [toApprove, trucks, trips, latest, cash] = await Promise.all([
    FundRequest.find({ status: 'owner' }).sort({ createdAt: 1 }).lean(),
    Vehicle.countDocuments({ status: 'active' }),
    Trip.aggregate<{ _id: string; n: number }>([
      { $project: { state: { $switch: { branches: [
        { case: { $ifNull: ['$cancelledAt', false] }, then: 'cancelled' },
        { case: { $ifNull: ['$settlementId', false] }, then: 'settled' },
        { case: { $ifNull: ['$endedAt', false] }, then: 'ended' },
        { case: { $ifNull: ['$dispatchedAt', false] }, then: 'on_road' },
      ], default: 'planned' } } } },
      { $group: { _id: '$state', n: { $sum: 1 } } },
    ]),
    Activity.find().sort({ at: -1, _id: -1 }).limit(12).lean(),
    balances(),
  ]);
  const byState = Object.fromEntries(trips.map((t) => [t._id, t.n]));
  const onTrip = await Trip.countDocuments({ active: true });
  return {
    currency: await baseCurrency(),
    toApprove: toApprove.map(present),
    fleet: { trucks, onTrip, free: Math.max(0, trucks - onTrip) },
    trips: { planned: byState.planned ?? 0, onRoad: byState.on_road ?? 0, ended: byState.ended ?? 0, settled: byState.settled ?? 0, cancelled: byState.cancelled ?? 0 },
    cashWithDriversMinor: cash.filter((c) => c.balanceMinor > 0).reduce((s, c) => s + c.balanceMinor, 0),
    latest: latest.map(present),
  };
}

/** Finance's queues: to approve, to pay, receipts to check, drivers to settle, cash with drivers. */
export async function financeDashboard() {
  const [requests, toPay, expenses, shortages, receipts, accounts, unsettled, cash] = await Promise.all([
    FundRequest.find({ status: 'pending' }).sort({ createdAt: 1 }).lean(),
    FundRequest.find({ status: 'approved' }).sort({ createdAt: 1 }).lean(),
    Expense.find({ status: 'pending' }).sort({ at: 1 }).lean(),
    Consignment.find({ 'shortage.status': 'pending' }).sort({ updatedAt: 1 }).lean(),
    DriverDocument.find({ status: 'new', kind: { $in: ['expense', 'fuel'] } }).sort({ at: 1 }).lean(),
    DriverAccount.find({ settleRequestedAt: { $exists: true } }).lean(),
    Trip.aggregate<{ _id: unknown; n: number }>([{ $match: { ...TO_SETTLE, driverId: { $exists: true } } }, { $group: { _id: '$driverId', n: { $sum: 1 } } }]),
    balances(),
  ]);
  const requested = new Map(accounts.map((a) => [String(a.driverId), a.settleRequestedAt]));
  const names = new Map((await Driver.find({ _id: { $in: unsettled.map((u) => u._id) } }).select('name').lean()).map((d) => [String(d._id), String(d.name)]));
  return {
    currency: await baseCurrency(),
    toApprove: { requests: requests.map(present), expenses: expenses.map(present), shortages: shortages.map(present) },
    toPay: toPay.map(present),
    receipts: receipts.map(present),
    driversToSettle: unsettled.map((u) => ({ driverId: String(u._id), name: names.get(String(u._id)) ?? '', trips: u.n, requestedAt: requested.get(String(u._id)) ?? null })),
    cashWithDrivers: cash,
  };
}

/** Everything the printed trip sheet shows. */
export async function tripSheet(id: string) {
  const trip = await Trip.findById(id).lean();
  if (!trip) throw new NotFoundError('Trip not found');
  const [requests, consignments, expenses, documents, company] = await Promise.all([
    FundRequest.find({ tripId: trip._id }).sort({ createdAt: 1 }).lean(),
    Consignment.find({ tripId: trip._id }).sort({ loadedAt: 1 }).lean(),
    Expense.find({ tripId: trip._id }).sort({ at: 1 }).lean(),
    DriverDocument.find({ tripId: trip._id }).select('-file.dataUrl').sort({ at: 1 }).lean(),
    Company.findOne().select('legalName tradingName address phone email').lean(),
  ]);
  return {
    trip: presentTrip(trip as Plain), requests: requests.map(present), consignments: consignments.map(present), expenses: expenses.map(present),
    documents: documents.map(present), activity: (await Activity.find({ tripId: trip._id }).sort({ at: 1 }).lean()).map(present),
    company: company ? present(company) : null, currency: await baseCurrency(),
  };
}

/**
 * The working set for the desks in one read: every trip-side record changed since `since`
 * (everything when omitted), plus the caller's read marks. Records are never deleted, so a client
 * merges by id. Only areas the caller may read are included, and only the threads they see.
 */
/** How far back the desks' first load reaches. Older records stay on the server, and can be asked for. */
export const HISTORY_DAYS = 30;

/**
 * What the desks' first load leaves out: trips settled or cancelled before the window starts, with what belongs to
 * them. It's fixed once they're that old, so what's left out can't change while the desks are open.
 */
async function historyScope(from: Date) {
  const oldSettlements = await Settlement.find({ postedAt: { $lt: from } }).select('_id').lean();
  const old: Plain = { $or: [{ settlementId: { $in: oldSettlements.map((s) => s._id) } }, { cancelledAt: { $lt: from } }] };
  return { old, kept: { $nor: [old] } as Plain };
}

/**
 * Each driver's balance from what the first load leaves out, in the same terms as `driverLedger`, so the desks can add
 * it to what they did load and arrive at the same balance. tests/history-window.test.ts holds the two together.
 */
async function carriedBalances(keptTripIds: unknown[], from: Date) {
  const totals = new Map<string, number>();
  const add = (driverId: unknown, minor: number) => { if (driverId && minor) totals.set(String(driverId), (totals.get(String(driverId)) ?? 0) + minor); };
  const [advances, shortages, writeOffs, expenses, settlements] = await Promise.all([
    FundRequest.aggregate<{ _id: unknown; sum: number }>([{ $match: { kind: 'cash', status: 'issued', tripId: { $nin: keptTripIds } } }, { $group: { _id: '$tripId', sum: { $sum: { $ifNull: ['$baseAmountMinor', 0] } } } }]),
    Consignment.aggregate<{ _id: unknown; sum: number }>([{ $match: { 'shortage.status': 'charged', tripId: { $nin: keptTripIds } } }, { $group: { _id: '$tripId', sum: { $sum: '$shortage.baseAmountMinor' } } }]),
    Consignment.aggregate<{ _id: unknown; sum: number }>([{ $match: { 'writeOff.status': 'approved', 'writeOff.carrier': 'driver', tripId: { $nin: keptTripIds } } }, { $group: { _id: '$tripId', sum: { $sum: '$writeOff.baseAmountMinor' } } }]),
    Expense.aggregate<{ _id: unknown; sum: number }>([{ $match: { status: 'approved', $nor: [{ tripId: { $in: keptTripIds } }, { tripId: null, at: { $gte: from } }] } }, { $group: { _id: '$driverId', sum: { $sum: '$baseAmountMinor' } } }]),
    Settlement.aggregate<{ _id: unknown; sum: number }>([{ $match: { postedAt: { $lt: from }, cashMinor: { $ne: 0 } } }, { $group: { _id: '$driverId', sum: { $sum: '$cashMinor' } } }]),
  ]);
  const byTrip = [...advances, ...shortages, ...writeOffs];
  const drivers = new Map((await Trip.find({ _id: { $in: byTrip.map((r) => r._id) } }).select('driverId').lean()).map((t) => [String(t._id), t.driverId]));
  for (const r of byTrip) add(drivers.get(String(r._id)), Number(r.sum));
  for (const r of expenses) add(r._id, -Number(r.sum));
  for (const r of settlements) add(r._id, -Number(r.sum));
  return Object.fromEntries(totals);
}

export async function sync(since: Date | undefined, viewer: Viewer, fromInput?: Date) {
  const { userId, can } = viewer;
  const serverTime = new Date();
  const from = fromInput ?? new Date(serverTime.getTime() - HISTORY_DAYS * 86400000);
  const changed: Plain = since ? { updatedAt: { $gt: since } } : {};
  const read = async (resource: string, run: () => Promise<unknown[]>) => (can(resource, 'read') ? run() : []);
  const { old, kept } = await historyScope(from);
  // On the first load, which trips are in. After that the desks hold them, so only what changed comes, within the window.
  const keptTrips = await Trip.find({ ...kept, ...changed }).lean();
  const keptIds = since ? (await Trip.find(kept).select('_id').lean()).map((t) => t._id) : keptTrips.map((t) => t._id);
  const ofKept: Plain = { ...changed, tripId: { $in: keptIds } };
  const orRecent = (field: string): Plain => ({ ...changed, $or: [{ tripId: { $in: keptIds } }, { tripId: null, [field]: { $gte: from } }] });
  const [trips, requests, documents, consignments, expenses, settlements, nominations, vehicleStates, driverAccounts, messages, activity] = await Promise.all([
    read('trips', async () => keptTrips.map((t) => presentTrip(t as Plain))),
    read('fund-requests', async () => (await FundRequest.find(ofKept).lean()).map(present)),
    read('driver-documents', async () => (await DriverDocument.find(orRecent('createdAt')).lean()).map(present)),
    read('consignments', async () => (await Consignment.find(ofKept).lean()).map(present)),
    read('expenses', async () => (await Expense.find(orRecent('at')).lean()).map(present)),
    read('settlements', async () => (await Settlement.find({ ...changed, postedAt: { $gte: from } }).lean()).map(present)),
    read('nominations', async () => (await Nomination.find({ ...changed, $or: [{ status: { $in: ['draft', 'sent', 'accepted'] } }, { updatedAt: { $gte: from } }] }).lean()).map(present)),
    read('vehicle-states', async () => (await VehicleState.find(changed).lean()).map(present)),
    read('settlements', async () => (await DriverAccount.find(changed).lean()).map(present)),
    read('messages', async () => (await Message.find({ ...changed, ...threadFilter(viewer) }).sort({ at: 1 }).limit(since ? 2000 : 1000).lean()).map(present)),
    read('activity', async () => (await Activity.find(changed).sort({ at: -1 }).limit(since ? 2000 : 500).lean()).map(present)),
  ]);
  // Only on the first load: what's left out doesn't change once it's that old.
  const history = since ? undefined : { from: from.toISOString(), older: Boolean(await Trip.exists(old)), carried: can('settlements', 'read') ? await carriedBalances(keptIds, from) : {} };
  const reads = (await ThreadRead.find({ userId }).lean()).map((r) => ({ thread: r.thread, at: r.at }));
  return { serverTime, since: since ?? null, ...(history ? { history } : {}), currency: await baseCurrency().catch(() => null), trips, requests, documents, consignments, expenses, settlements, nominations, vehicleStates, driverAccounts, messages, activity, reads };
}
