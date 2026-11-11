// #125: the desks' first load covers recent records only. What it leaves out must not change any driver's balance.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { driverLedger, sumOf } from '../src/modules/operations/ledger.js';
import { Settlement } from '../src/modules/operations/models/money.model.js';
import { Trip } from '../src/modules/operations/models/trip.model.js';
import { api, bearer, loadSample, resetDatabase, signUp, startDatabase, stopDatabase, type Session } from './helpers.js';

let owner: Session;
type Rec = Record<string, any>;
const sync = async (query: string) => (await api().get(`/api/v1/operations/sync${query}`).set(bearer(owner)).expect(200)).body.data as Rec;
/** A driver's balance as the desks add it up (`driverLedger` in web/src/domain/calc.ts), from one sync's answer. */
function balanceFrom(res: Rec, driverId: string) {
  const trips = new Set((res.trips as Rec[]).filter((t) => t.driverId === driverId).map((t) => t.id));
  let sum = res.history?.carried?.[driverId] ?? 0;
  for (const r of res.requests as Rec[]) if (trips.has(r.tripId) && r.kind === 'cash' && r.status === 'issued') sum += r.baseAmountMinor ?? 0;
  for (const e of res.expenses as Rec[]) if (e.driverId === driverId && e.status === 'approved') sum -= e.baseAmountMinor;
  for (const c of res.consignments as Rec[]) {
    if (!trips.has(c.tripId)) continue;
    if (c.shortage?.status === 'charged') sum += c.shortage.baseAmountMinor;
    if (c.writeOff?.status === 'approved' && c.writeOff.carrier === 'driver') sum += c.writeOff.baseAmountMinor;
  }
  for (const s of res.settlements as Rec[]) if (s.driverId === driverId) sum -= s.cashMinor;
  return sum;
}

before(startDatabase);
after(stopDatabase);

describe('what the first load leaves out', () => {
  test('every driver\'s balance stays exact, older trips can be asked for, and open work is never left out', async () => {
    await resetDatabase();
    owner = await signUp('Owner');
    await loadSample(owner, 'full');
    const settled = await Settlement.find().lean();
    assert.ok(settled.length >= 2, 'the sample has settlements to age');
    // Half the settlements, and a cancelled trip if there is one, become a year old.
    const aged = settled.slice(0, Math.ceil(settled.length / 2));
    const longAgo = new Date(Date.now() - 365 * 86400000);
    await Settlement.collection.updateMany({ _id: { $in: aged.map((s) => s._id) } }, { $set: { postedAt: longAgo } });
    const oldTrips = (await Trip.find({ settlementId: { $in: aged.map((s) => s._id) } }).select('_id').lean()).map((t) => String(t._id));
    assert.ok(oldTrips.length > 0, 'trips belong to them');

    const res = await sync('');
    assert.equal(res.history.older, true);
    const loaded = new Set((res.trips as Rec[]).map((t) => t.id));
    for (const id of oldTrips) assert.ok(!loaded.has(id), 'an old settled trip is left out');
    const openTrip = await Trip.findOne({ settlementId: null, cancelledAt: null }).select('_id').lean();
    if (openTrip) assert.ok(loaded.has(String(openTrip._id)), 'open work is never left out');
    assert.ok(Object.keys(res.history.carried).length > 0, 'something is carried');

    const drivers = (await api().get('/api/v1/drivers?limit=100').set(bearer(owner)).expect(200)).body.data as Rec[];
    assert.ok(drivers.length > 0);
    for (const d of drivers) {
      const opening = (await driverLedger(d.id)).filter((e) => e.kind === 'opening');
      assert.equal(balanceFrom(res, d.id) + sumOf(opening), sumOf(await driverLedger(d.id)), `${String(d.name)}: the same balance as the full ledger`);
    }

    // Asking further back brings them in, with nothing carried from them any more.
    const all = await sync(`?from=${encodeURIComponent(new Date(Date.now() - 800 * 86400000).toISOString())}`);
    const everything = new Set((all.trips as Rec[]).map((t) => t.id));
    for (const id of oldTrips) assert.ok(everything.has(id), 'an old trip loads when asked for');
    assert.equal(all.history.older, false);
    assert.deepEqual(all.history.carried, {});
    for (const d of drivers) {
      const opening = (await driverLedger(d.id)).filter((e) => e.kind === 'opening');
      assert.equal(balanceFrom(all, d.id) + sumOf(opening), sumOf(await driverLedger(d.id)));
    }

    // After the first load, only changes come, and the window stays put.
    const later = await sync(`?since=${encodeURIComponent(res.serverTime)}&from=${encodeURIComponent(res.history.from)}`);
    assert.equal(later.history, undefined);
    // Only what changed in the last few seconds comes again, the look-back that catches writes still saving (#102).
    const cutoff = Date.parse(res.serverTime) - 10_000;
    assert.ok((later.trips as Array<{ updatedAt: string }>).every((t) => Date.parse(t.updatedAt) > cutoff), 'nothing older than the look-back');
  });
});

describe('the lookups the desks use on long lists', () => {
  test('find the same things, in the same order, as looking through the list', async () => {
    const calc = '../web/src/domain/calc.js';
    const { byId, whereIs } = await import(calc) as {
      byId: <T extends { id: string }>(list: T[], id?: string) => T | undefined;
      whereIs: <T extends object, K extends keyof T & string>(list: readonly T[], field: K, value: T[K] | undefined) => readonly T[];
    };
    const list = Array.from({ length: 300 }, (_, n) => ({ id: `r${String(n)}`, tripId: `t${String(n % 7)}` as string | undefined }));
    list[5]!.tripId = undefined;
    for (const value of ['t0', 't6', undefined, 'nobody']) assert.deepEqual(whereIs(list, 'tripId', value), list.filter((r) => r.tripId === value));
    assert.equal(byId(list, 'r299'), list[299]);
    assert.equal(byId(list, 'nobody'), undefined);
    assert.equal(byId(list, undefined), undefined);
    // A list that has grown since it was first asked about.
    list.push({ id: 'r300', tripId: 't0' });
    assert.equal(byId(list, 'r300'), list[300]);
    assert.equal(whereIs(list, 'tripId', 't0').at(-1), list[300]);
  });
});
