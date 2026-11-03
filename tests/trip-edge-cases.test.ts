import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { api, bearer, find, loadSample, resetDatabase, signUp, startDatabase, stopDatabase, userWithRole, type Session } from './helpers.js';

/** Trip edge cases found while testing the desks in the browser (#16). */
let owner: Session, ops: Session, fin: Session;
const ids: Record<string, string> = {};

const as = (s: Session) => ({
  get: (path: string) => api().get(`/api/v1${path}`).set(bearer(s)),
  post: (path: string, body: unknown = {}) => api().post(`/api/v1${path}`).set(bearer(s)).send(body as object),
  patch: (path: string, body: unknown) => api().patch(`/api/v1${path}`).set(bearer(s)).send(body as object),
  put: (path: string, body: unknown) => api().put(`/api/v1${path}`).set(bearer(s)).send(body as object),
});
const ok = <T = any>(res: { status: number; body: any }, status = 200): T => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body.data as T;
};

async function newTrip(vehicle = 'v1', driver = 'd1', trailer = 't1') {
  ok(await as(ops).put(`/vehicle-states/${ids[vehicle]}`, { placeId: ids.depot, fuelL: 200 }));
  return ok(await as(ops).post('/trips', {
    customerId: ids.zambezi, vehicleId: ids[vehicle], driverId: ids[driver], trailerId: ids[trailer], routeId: ids.routeDar,
    plannedStart: '2026-11-03T06:00:00.000Z', productId: ids.diesel,
  }), 201);
}

async function paidAdvance(tripId: string, amountMinor: number) {
  const r = ok(await as(ops).post('/fund-requests', { tripId, kind: 'cash', amount: { amountMinor, currencyId: ids.ZMW } }), 201);
  ok(await as(fin).post(`/fund-requests/${r.id}/decide`, { approve: true }));
  ok(await as(fin).post(`/fund-requests/${r.id}/issue`, { paymentMethodId: ids.pmCash }));
  return r;
}

before(startDatabase);
after(stopDatabase);
beforeEach(async () => {
  await resetDatabase();
  owner = await signUp('Owner');
  await loadSample(owner);
  ops = await userWithRole(owner, 'operations', 'Olivia Ops');
  fin = await userWithRole(owner, 'finance', 'Felix Finance');
  const lookups: Array<[string, string, string]> = [
    ['zambezi', 'parties', 'Zambezi'], ['v1', 'vehicles', 'ALC 4821'], ['v2', 'vehicles', 'BCA 9034'], ['t1', 'trailers', 'TAC 7821'], ['t2', 'trailers', 'TBL 6206'],
    ['d1', 'drivers', 'Joseph'], ['d2', 'drivers', 'Martha'], ['routeDar', 'routes', 'DAR-LSK'], ['depot', 'places', 'LSK-DEPOT'],
    ['diesel', 'products', 'DIESEL-50'], ['ZMW', 'currencies', 'ZMW'], ['pmCash', 'payment-methods', 'CASH'],
  ];
  for (const [key, master, search] of lookups) ids[key] = (await find(owner, master, search)).id;
});

describe('a trip cancelled after cash was paid', () => {
  test('goes on the driver\'s settlement, and the cash can be handed back', async () => {
    const trip = await newTrip();
    await paidAdvance(trip.id, 2000_00);
    ok(await as(ops).post(`/trips/${trip.id}/cancel`, { reason: 'Customer postponed the load' }));

    const account = ok(await as(fin).get(`/driver-accounts/${ids.d1}`));
    assert.equal(account.balanceMinor, 2000_00);
    assert.deepEqual(account.unsettledTrips.map((t: { id: string }) => t.id), [trip.id]);
    const listed = ok<any[]>(await as(fin).get('/driver-accounts')).find((a) => a.driverId === ids.d1);
    assert.equal(listed.unsettledTrips, 1);

    ok(await as(fin).post('/settlements', { driverId: ids.d1, tripIds: [trip.id], cashMinor: 2000_00 }), 201);
    assert.equal(ok(await as(fin).get(`/driver-accounts/${ids.d1}`)).balanceMinor, 0);
    assert.deepEqual(ok(await as(fin).get(`/driver-accounts/${ids.d1}`)).unsettledTrips, []);
  });

  test('a trip cancelled with no cash on it is not waiting for settlement', async () => {
    const trip = await newTrip();
    const fuel = ok(await as(ops).post('/fund-requests', { tripId: trip.id, kind: 'fuel', litres: 100 }), 201);
    ok(await as(fin).post(`/fund-requests/${fuel.id}/decide`, { approve: true }));
    ok(await as(ops).post(`/trips/${trip.id}/cancel`, { reason: 'Truck needed elsewhere' }));
    assert.deepEqual(ok(await as(fin).get(`/driver-accounts/${ids.d1}`)).unsettledTrips, []);
    assert.equal(ok(await as(ops).get(`/fund-requests/${fuel.id}`)).status, 'cancelled');
    await as(fin).post('/settlements', { driverId: ids.d1, tripIds: [trip.id], cashMinor: 0 }).expect(422);
  });
});

describe('two people saving the same plan', () => {
  test('the second save, based on the old version, is refused instead of overwriting the first', async () => {
    const trip = await newTrip();
    ok(await as(ops).patch(`/trips/${trip.id}`, { version: trip.version, cashBudgetMinor: 6000_00 }));
    const stale = await as(ops).patch(`/trips/${trip.id}`, { version: trip.version, cashBudgetMinor: 7000_00 });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(ok(await as(ops).get(`/trips/${trip.id}`)).cashBudget.amountMinor, 6000_00);
  });
});
