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

/** Funds, dispatches, loads and delivers a trip with 0.5 % lost at 20 °C, beyond the 0.3 % allowance. */
async function deliveredShort() {
  const trip = await newTrip();
  const f = ok(await as(ops).get(`/trips/${trip.id}/funding`));
  const fuel = ok(await as(ops).post('/fund-requests', { tripId: trip.id, kind: 'fuel', litres: f.fuel.suggested }), 201);
  ok(await as(fin).post(`/fund-requests/${fuel.id}/decide`, { approve: true }));
  ok(await as(fin).post(`/fund-requests/${fuel.id}/issue`, { paymentMethodId: ids.pmDepot, reference: 'DP-1', station: 'Lusaka fuel depot' }));
  ok(await as(ops).post(`/trips/${trip.id}/dispatch`));
  ok(await as(ops).post(`/trips/${trip.id}/position`, { km: 1961, speed: 0, source: 'simulator' }));
  const load = ok(await as(ops).post('/consignments', { tripId: trip.id, productId: ids.diesel, invoiceNo: 'INV-1', qty: 38000, ambientL: 38000, tempC: 28, density: 835 }), 201);
  ok(await as(ops).post(`/trips/${trip.id}/position`, { km: 9999, speed: 0, source: 'simulator' }));
  const delivered20 = Math.round(load.load.std20L * 0.995);
  const delivery = ok(await as(ops).post(`/consignments/${load.id}/delivery`, { podNo: 'POD-1', qty: 37800, ambientL: 37800, tempC: 20, density: 835, certStd20L: delivered20 }));
  assert.equal(delivery.shortage.status, 'pending');
  return delivery;
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
    ['diesel', 'products', 'DIESEL-50'], ['ZMW', 'currencies', 'ZMW'], ['pmCash', 'payment-methods', 'CASH'], ['pmDepot', 'payment-methods', 'DEPOT'],
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

describe('waiving a shortage follows the shortage-waiver policy', () => {
  test('a role the policy names may waive without the shortage permission, but not charge', async () => {
    const opsRole = (await find(owner, 'roles', 'operations')).id;
    ok(await as(owner).post('/approval-policies', { code: 'WAIVE', name: 'Shortage waivers', subject: 'shortage_waiver', currencyId: ids.ZMW, levels: [{ level: 1, minAmountMinor: 0, approverRoleId: opsRole }] }), 201);
    const delivery = await deliveredShort();
    assert.equal(delivery.shortage.approval.levels.at(-1).approverRoleKey, 'operations', 'the waiver is routed when the delivery is recorded');
    await as(ops).post(`/consignments/${delivery.id}/shortage-decision`, { charge: true }).expect(403);
    await as(fin).post(`/consignments/${delivery.id}/shortage-decision`, { charge: false, note: 'Meter fault at the depot' }).expect(403);
    const waived = ok(await as(ops).post(`/consignments/${delivery.id}/shortage-decision`, { charge: false, note: 'Meter fault at the depot' }));
    assert.equal(waived.shortage.status, 'waived');
  });

  test('without a policy, the shortage permission decides both', async () => {
    const delivery = await deliveredShort();
    await as(ops).post(`/consignments/${delivery.id}/shortage-decision`, { charge: false, note: 'No' }).expect(403);
    assert.equal(ok(await as(fin).post(`/consignments/${delivery.id}/shortage-decision`, { charge: false, note: 'Meter fault' })).shortage.status, 'waived');
  });
});

describe('messages from the driver', () => {
  test('the office marks a message done; it then stops waiting, and documents to record cannot be marked done', async () => {
    const trip = await newTrip();
    const message = ok(await as(ops).post('/whatsapp/simulate', { driverId: ids.d1, text: 'Tyre burst near Mpika' }), 201);
    assert.equal(message.kind, 'other');
    const inbox = ok<any[]>(await as(ops).get('/messages?thread=queue:consignments'));
    assert.ok(inbox.find((m) => m.refId === message.id).buttons.some((b: any) => b.action?.type === 'doc.done'), 'the message offers Done');
    const viewer = await userWithRole(owner, 'viewer', 'Vera Viewer');
    await as(viewer).post(`/driver-documents/${message.id}/done`).expect(403);
    const done = ok(await as(ops).post(`/driver-documents/${message.id}/done`));
    assert.equal(done.status, 'recorded');
    await as(ops).post(`/driver-documents/${message.id}/done`).expect(409);
    assert.equal(ok<any[]>(await as(ops).get('/messages?thread=queue:consignments')).find((m) => m.refId === message.id).resolved, 'Done by Olivia Ops');
    const receipt = ok(await as(ops).post('/whatsapp/simulate', { driverId: ids.d1, tripId: trip.id, kind: 'expense', file: { name: 'r.jpg', mime: 'image/jpeg', sampleId: 'expense:1:0' } }), 201);
    await as(ops).post(`/driver-documents/${receipt.id}/done`).expect(422);
  });
});

describe('delivered more than loaded', () => {
  test('fuel is compared at 20 °C: a delivery over the allowed margin is refused even when the ambient litres look fine', async () => {
    const trip = await newTrip();
    const f = ok(await as(ops).get(`/trips/${trip.id}/funding`));
    const fuel = ok(await as(ops).post('/fund-requests', { tripId: trip.id, kind: 'fuel', litres: f.fuel.suggested }), 201);
    ok(await as(fin).post(`/fund-requests/${fuel.id}/decide`, { approve: true }));
    ok(await as(fin).post(`/fund-requests/${fuel.id}/issue`, { paymentMethodId: ids.pmDepot, reference: 'DP-2', station: 'Lusaka fuel depot' }));
    ok(await as(ops).post(`/trips/${trip.id}/dispatch`));
    ok(await as(ops).post(`/trips/${trip.id}/position`, { km: 1961, speed: 0, source: 'simulator' }));
    // Loaded warm (28 °C): 38,000 L ambient is about 37,750 L at 20 °C.
    const load = ok(await as(ops).post('/consignments', { tripId: trip.id, productId: ids.diesel, invoiceNo: 'INV-2', qty: 38000, ambientL: 38000, tempC: 28, density: 835 }), 201);
    ok(await as(ops).post(`/trips/${trip.id}/position`, { km: 9999, speed: 0, source: 'simulator' }));
    const loaded20 = load.load.std20L as number;
    // 38,600 L ambient is within 2 % of 38,000 ambient, but 38,600 L at 20 °C is 2.3 % over what was loaded.
    const over = await as(ops).post(`/consignments/${load.id}/delivery`, { podNo: 'POD-OVER', qty: 38600, ambientL: 38600, tempC: 20, density: 835, certStd20L: 38600 });
    assert.equal(over.status, 422, JSON.stringify(over.body));
    assert.match(over.body.error.message, /more than loaded/);
    // Within the margin (1 % over at 20 °C) is accepted, with no loss.
    const fine = Math.round(loaded20 * 1.01);
    const delivery = ok(await as(ops).post(`/consignments/${load.id}/delivery`, { podNo: 'POD-OK', qty: fine, ambientL: fine, tempC: 20, density: 835, certStd20L: fine }));
    assert.equal(delivery.shortage.lossL, 0);
  });
});

describe('stopping a trip that left but never loaded', () => {
  test('frees the truck where it is, cancels open requests, keeps paid cash for settlement; refused once loaded or when switched off', async () => {
    const trip = await newTrip();
    await paidAdvance(trip.id, 150000);
    // Not yet on the road: cancel, not stop.
    await as(ops).post(`/trips/${trip.id}/stop`, { reason: 'Customer cancelled', closingFuelL: 150 }).expect(409);
    ok(await as(ops).post(`/trips/${trip.id}/dispatch`));
    // A request made on the road and not yet decided.
    const open = ok(await as(ops).post('/fund-requests', { tripId: trip.id, kind: 'cash', amount: { amountMinor: 50000, currencyId: ids.ZMW } }), 201);
    // Nobody without trips:update may stop it.
    const viewer = await userWithRole(owner, 'viewer');
    await as(viewer).post(`/trips/${trip.id}/stop`, { reason: 'x', closingFuelL: 150 }).expect(403);
    const stopped = ok(await as(ops).post(`/trips/${trip.id}/stop`, { reason: 'Customer cancelled the order.', closingFuelL: 150, placeId: ids.depot }));
    assert.equal(stopped.stopReason, 'Customer cancelled the order.');
    assert.ok(stopped.endedAt);
    assert.equal(stopped.active, false);
    const request = ok(await as(ops).get(`/fund-requests/${open.id}`));
    assert.equal(request.status, 'cancelled');
    const state = ok<any[]>(await as(ops).get('/vehicle-states')).find((v) => v.vehicleId === ids.v1);
    assert.deepEqual([state.placeId, state.fuelL], [ids.depot, 150]);
    // The truck, trailer and driver can go on a new trip straight away.
    const next = await newTrip();
    assert.ok(next.id);
    // Stopping twice, or a loaded trip, is refused.
    await as(ops).post(`/trips/${trip.id}/stop`, { reason: 'again', closingFuelL: 150 }).expect(409);
  });

  test('a loaded trip cannot be stopped, and a company can switch stopping off', async () => {
    const loaded = await newTrip();
    ok(await as(ops).post(`/trips/${loaded.id}/dispatch`));
    ok(await as(ops).post(`/trips/${loaded.id}/position`, { km: 1961, speed: 0, source: 'simulator' }));
    ok(await as(ops).post('/consignments', { tripId: loaded.id, productId: ids.diesel, invoiceNo: 'INV-S', qty: 38000, ambientL: 38000, tempC: 28, density: 835 }), 201);
    const refused = await as(ops).post(`/trips/${loaded.id}/stop`, { reason: 'Accident', closingFuelL: 100 });
    assert.equal(refused.status, 422);
    assert.match(refused.body.error.message, /loaded/);
    const company = ok(await as(owner).get('/company'));
    ok(await as(owner).put('/company', { legalName: company.legalName, version: company.version, operations: { ...company.operations, stopBeforeLoading: false } }));
    const other = await newTrip('v2', 'd2', 't2');
    ok(await as(ops).post(`/trips/${other.id}/dispatch`));
    const off = await as(ops).post(`/trips/${other.id}/stop`, { reason: 'Breakdown', closingFuelL: 100 });
    assert.equal(off.status, 422);
    assert.match(off.body.error.message, /does not stop trips/);
  });
});

