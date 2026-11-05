// #35: arrivals follow the trip's stops and its cargo. Nothing after loading before the loading is
// recorded, nothing after offloading before the delivery is, on every path: driver app, office, simulator.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { api, bearer, find, loadSample, resetDatabase, signUp, startDatabase, stopDatabase, userWithRole, type Session } from './helpers.js';

let owner: Session, ops: Session, fin: Session;
const ids: Record<string, string> = {};
type Stop = { id: string; kind: string; placeId: string; arrivedAt?: string };
type Trip = { id: string; stops: Stop[]; tracking?: { km: number } };

const as = (s: { token: string }) => ({
  get: (path: string) => api().get(`/api/v1${path}`).set(bearer(s)),
  post: (path: string, body: unknown = {}) => api().post(`/api/v1${path}`).set(bearer(s)).send(body as object),
  put: (path: string, body: unknown) => api().put(`/api/v1${path}`).set(bearer(s)).send(body as object),
});
const ok = <T = any>(res: { status: number; body: any }, status = 200): T => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body.data as T;
};
const stop = (trip: Trip, kind: string) => trip.stops.find((s) => s.kind === kind)!;

/** A fuel trip, funded and on the road: start, load, border, offload, end. */
async function tripOnTheRoad(): Promise<Trip> {
  ok(await as(ops).put(`/vehicle-states/${ids.v1}`, { placeId: ids.depot, fuelL: 200 }));
  const trip = ok(await as(ops).post('/trips', {
    customerId: ids.zambezi, vehicleId: ids.v1, driverId: ids.d1, trailerId: ids.t1, routeId: ids.routeDar,
    plannedStart: '2026-11-03T06:00:00.000Z', productId: ids.diesel,
  }), 201);
  const f = ok(await as(ops).get(`/trips/${trip.id}/funding`));
  const fuel = ok(await as(ops).post('/fund-requests', { tripId: trip.id, kind: 'fuel', litres: f.fuel.suggested }), 201);
  ok(await as(fin).post(`/fund-requests/${fuel.id}/decide`, { approve: true }));
  ok(await as(fin).post(`/fund-requests/${fuel.id}/issue`, { paymentMethodId: ids.pmDepot, reference: 'DP-1' }));
  const onRoad = ok<Trip>(await as(ops).post(`/trips/${trip.id}/dispatch`));
  assert.deepEqual(onRoad.stops.map((s) => s.kind), ['start', 'load', 'border', 'offload', 'end']);
  return onRoad;
}

async function load(trip: Trip) {
  return ok(await as(ops).post('/consignments', { tripId: trip.id, productId: ids.diesel, invoiceNo: 'INV-1', qty: 38000, ambientL: 38000, tempC: 20, density: 835 }), 201);
}
async function deliver(consignment: { id: string; load: { std20L: number } }) {
  ok(await as(ops).post(`/consignments/${consignment.id}/delivery`, { podNo: 'POD-1', qty: 38000, ambientL: 38000, tempC: 20, density: 835, certStd20L: consignment.load.std20L }));
}
const tripNow = async (trip: Trip) => ok<Trip>(await as(ops).get(`/trips/${trip.id}`));
const offloadPlace = async (trip: Trip) => String(ok(await as(owner).get(`/places/${stop(trip, 'offload').placeId}`)).name);

async function driverSignsIn() {
  ok(await as(owner).put(`/users/driver-access/${ids.d1}`, { phone: '+260971234567', password: 'Truck2026' }));
  const res = await api().post('/api/v1/auth/login').send({ phone: '+260971234567', password: 'Truck2026' });
  return { token: ok<{ accessToken: string }>(res).accessToken };
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
    ['zambezi', 'parties', 'Zambezi'], ['v1', 'vehicles', 'ALC 4821'], ['t1', 'trailers', 'TAC 7821'], ['d1', 'drivers', 'Joseph'],
    ['routeDar', 'routes', 'DAR-LSK'], ['depot', 'places', 'LSK-DEPOT'], ['diesel', 'products', 'DIESEL-50'], ['pmDepot', 'payment-methods', 'DEPOT'],
  ];
  for (const [key, master, search] of lookups) ids[key] = (await find(owner, master, search)).id;
});

describe('arrivals follow the cargo', () => {
  test('driver app: the final stop waits for the delivery; stops in between still go in order', async () => {
    const trip = await tripOnTheRoad();
    const driver = await driverSignsIn();
    const arrive = (kind: string) => as(driver).post(`/driver-app/stops/${stop(trip, kind).id}/arrive`);

    ok(await arrive('load'));
    const border = await arrive('border');
    assert.equal(border.status, 422);
    assert.equal(border.body.error.message, 'Waiting for Operations to record the loading.');

    const consignment = await load(trip);
    ok(await arrive('border'), 200);
    ok(await arrive('offload'));
    const kmAtOffload = (await tripNow(trip)).tracking!.km;
    const early = await arrive('end');
    assert.equal(early.status, 422);
    assert.equal(early.body.error.message, `Waiting for Operations to record the delivery at ${await offloadPlace(trip)}.`);
    const held = await tripNow(trip);
    assert.equal(stop(held, 'end').arrivedAt, undefined, 'the final stop is not stamped');
    assert.equal(held.tracking!.km, kmAtOffload, 'a refused arrival leaves the truck where it was');

    await deliver(consignment);
    ok(await arrive('end'));
    assert.ok(stop(await tripNow(trip), 'end').arrivedAt);
  });

  test('office: the same rule, and an arrival already recorded can be sent again', async () => {
    const trip = await tripOnTheRoad();
    const arrive = (kind: string) => as(ops).post(`/trips/${trip.id}/stops/${stop(trip, kind).id}/arrive`);

    assert.equal((await arrive('offload')).body.error.message, 'Record the loading first.');
    const consignment = await load(trip);
    const jumped = await arrive('end');
    assert.equal(jumped.status, 422, 'straight from loading to the final stop is refused too');
    assert.equal(jumped.body.error.message, `Record the delivery at ${await offloadPlace(trip)} first.`);
    assert.equal(stop(await tripNow(trip), 'offload').arrivedAt, undefined, 'and stamps nothing on the way');

    ok(await arrive('border'));
    ok(await arrive('offload'));
    ok(await arrive('offload'), 200);
    await deliver(consignment);
    ok(await arrive('end'));
  });

  test('simulator: the drive is held at loading, then at offloading, until the cargo is recorded', async () => {
    const trip = await tripOnTheRoad();
    const drive = async (km: number) => ok<Trip>(await as(ops).post(`/trips/${trip.id}/position`, { km, speed: 70, source: 'simulator' }));
    const toEnd = 99_999;

    let now = await drive(toEnd);
    assert.ok(stop(now, 'load').arrivedAt);
    assert.equal(stop(now, 'border').arrivedAt, undefined, 'held at loading');

    const consignment = await load(trip);
    now = await drive(toEnd);
    assert.ok(stop(now, 'offload').arrivedAt);
    assert.equal(stop(now, 'end').arrivedAt, undefined, 'held at offloading');

    await deliver(consignment);
    now = await drive(toEnd);
    assert.ok(stop(now, 'end').arrivedAt, 'after the delivery the drive reaches the final stop');
  });
});
