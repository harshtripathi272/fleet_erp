import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { api, bearer, loadSample, signUp, startDatabase, stopDatabase, type Session } from './helpers.js';

/**
 * The full sample (the console's "Load sample data" and `npm run seed`): a fleet of ten with trips at
 * every stage, made through the services the desks use. The other tests load the small sample.
 */
let owner: Session;
let created = 0;
before(async () => {
  await startDatabase();
  owner = await signUp('Owner');
  created = await loadSample(owner, 'full');
});
after(stopDatabase);

const get = async (path: string, query: Record<string, unknown> = {}) => {
  const res = await api().get(`/api/v1${path}`).query(query).set(bearer(owner));
  assert.equal(res.status, 200, `${path}: ${JSON.stringify(res.body)}`);
  return res.body as { data: any; meta?: { total: number } };
};
const total = async (path: string, query: Record<string, unknown> = {}) => (await get(path, { ...query, limit: 1 })).meta!.total;

describe('the full sample', () => {
  test('a fleet of ten trucks, trailers and drivers with their documents', async () => {
    assert.ok(created > 200, `created ${created}`);
    for (const master of ['vehicles', 'trailers', 'drivers']) assert.equal(await total(`/${master}`), 10, master);
    assert.equal(await total('/parties'), 8);
    assert.equal(await total('/routes'), 3);
    assert.equal(await total('/compliance-documents'), 3 + 16, 'road tax and a licence for each added truck and driver');
  });

  test('trips at every stage', async () => {
    const states = { settled: 4, ended: 2, on_road: 2, planned: 2 };
    for (const [state, count] of Object.entries(states)) assert.equal(await total('/trips', { state }), count, state);
    const onRoad = (await get('/trips', { state: 'on_road' })).data as Array<{ stops: Array<{ kind: string; arrivedAt?: string }> }>;
    assert.ok(onRoad.some((t) => t.stops.some((s) => s.kind === 'border' && s.arrivedAt)), 'one truck is through the border');
  });

  test('money and documents waiting on each desk', async () => {
    const pending = (await get('/fund-requests', { status: 'pending' })).data as Array<{ kind: string; approval: { current: number; levels: Array<{ label: string }> } }>;
    assert.deepEqual(pending.map((r) => [r.kind, r.approval.levels[r.approval.current]?.label]), [['cash', 'Owner']], 'cash above budget, approved by Finance, waiting for the Owner');
    assert.equal(await total('/fund-requests', { status: 'approved' }), 1, 'fuel approved, not yet paid');
    assert.equal(await total('/driver-documents', { status: 'returned' }), 1);
    assert.equal(await total('/driver-documents', { status: 'new' }), 2, 'a resent receipt and a loading invoice to confirm');
    assert.equal(await total('/consignments', { shortage: 'charged' }), 1);
    assert.equal(await total('/consignments', { shortage: 'waived' }), 1);
    assert.equal(await total('/nominations', { status: 'sent' }), 1);
    const finance = (await get('/dashboards/finance')).data;
    assert.ok(finance.toApprove.requests.length >= 1);
    await get('/dashboards/owner');
  });

  test('settlements: in full, across two trips with cash carried forward, and with the company paying the driver', async () => {
    const settlements = (await get('/settlements', { limit: 10 })).data as Array<{ tripIds: string[]; cashMinor: number; closingMinor: number }>;
    assert.equal(settlements.length, 3);
    assert.ok(settlements.some((s) => s.tripIds.length === 2 && s.closingMinor === 1000_00));
    assert.ok(settlements.some((s) => s.cashMinor < 0 && s.closingMinor === 0));
    assert.ok(settlements.some((s) => s.tripIds.length === 1 && s.cashMinor > 0 && s.closingMinor === 0));
    const accounts = (await get('/driver-accounts')).data as Array<{ name: string; settleRequestedAt?: string | null }>;
    assert.ok(accounts.some((a) => a.settleRequestedAt), 'one driver waiting to be settled');
  });

  test('one truck carrying three consignments, two loaded at Dar es Salaam and one at Lusaka, one split late, each priced (#135)', async () => {
    const trips = (await get('/trips', { state: 'ended', limit: 10 })).data as Array<{ id: string }>;
    const lists = await Promise.all(trips.map(async (t) => (await get('/consignments', { tripId: t.id, limit: 50 })).data as Array<{ status: string; rate?: unknown; revenue?: { totalMinor: number }; legs: Array<{ kind: string; status: string }> }>));
    const shared = lists.find((l) => l.length === 3);
    assert.ok(shared, 'a trip with three consignments');
    for (const c of shared) {
      assert.equal(c.status, 'delivered');
      assert.ok(c.rate, 'a rate agreed with the customer');
      assert.ok((c.revenue?.totalMinor ?? 0) > 0, 'priced');
    }
    assert.ok(shared.some((c) => c.legs.filter((l) => l.kind === 'drop').length === 2), 'one delivery split between two drops');
  });

  test('loads only once', async () => {
    const again = await api().post('/api/v1/meta/sample-data').set(bearer(owner)).send({});
    assert.equal(again.status, 409);
  });
});
