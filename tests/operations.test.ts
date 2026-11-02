import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { env } from '../src/config/env.js';
import { setWhatsAppTransport, type OutboundWhatsApp } from '../src/modules/operations/marichiTalks.js';
import { api, bearer, errorCode, find, loadSample, resetDatabase, signUp, startDatabase, stopDatabase, userWithRole, type Session } from './helpers.js';

/**
 * The trip-flow mock's business rules on the real API: nominations, trips, money requests, driver
 * documents, loading and delivery with the 20 °C correction, shortages, expenses, settlement,
 * messages and dashboards, each action done by the desk that owns it.
 */
let owner: Session, ops: Session, fin: Session, viewer: Session;
const ids: Record<string, string> = {};

async function setUp() {
  owner = await signUp('Owner');
  await loadSample(owner);
  ops = await userWithRole(owner, 'operations', 'Olivia Ops');
  fin = await userWithRole(owner, 'finance', 'Felix Finance');
  viewer = await userWithRole(owner, 'viewer', 'Vera Viewer');
  const lookups: Array<[string, string, string]> = [
    ['zambezi', 'parties', 'Zambezi'], ['copper', 'parties', 'Copperbelt'], ['leasing', 'parties', 'Afri Asset'],
    ['v1', 'vehicles', 'ALC 4821'], ['v2', 'vehicles', 'BCA 9034'], ['t1', 'trailers', 'TAC 7821'], ['t2', 'trailers', 'TBL 6206'],
    ['d1', 'drivers', 'Joseph'], ['d2', 'drivers', 'Martha'], ['routeDar', 'routes', 'DAR-LSK'],
    ['depot', 'places', 'LSK-DEPOT'], ['darPort', 'places', 'DAR-PORT'], ['ndola', 'places', 'NDL-YARD'], ['nakonde', 'places', 'NAKONDE'],
    ['diesel', 'products', 'DIESEL-50'], ['copperCathode', 'products', 'CU-CATH'], ['ZMW', 'currencies', 'ZMW'], ['USD', 'currencies', 'USD'],
    ['pmCash', 'payment-methods', 'CASH'], ['pmDepot', 'payment-methods', 'DEPOT'], ['ecRoad', 'expense-categories', 'ROAD'],
    ['direct', 'order-sources', 'DIRECT'], ['broker', 'order-sources', 'BROKER'],
  ];
  for (const [key, master, search] of lookups) ids[key] = (await find(owner, master, search)).id;
}

const as = (s: Session) => ({
  get: (path: string, query: Record<string, unknown> = {}) => api().get(`/api/v1${path}`).query(query).set(bearer(s)),
  post: (path: string, body: unknown = {}) => api().post(`/api/v1${path}`).set(bearer(s)).send(body as object),
  patch: (path: string, body: unknown) => api().patch(`/api/v1${path}`).set(bearer(s)).send(body as object),
  put: (path: string, body: unknown) => api().put(`/api/v1${path}`).set(bearer(s)).send(body as object),
});

const ok = <T = any>(res: { status: number; body: any }, status = 200): T => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body.data as T;
};

async function newTrip(vehicle = 'v1', driver = 'd1', trailer = 't1', fuelL = 200) {
  ok(await as(ops).put(`/vehicle-states/${ids[vehicle]}`, { placeId: ids.depot, fuelL }));
  return ok(await as(ops).post('/trips', {
    customerId: ids.zambezi, vehicleId: ids[vehicle], driverId: ids[driver], trailerId: ids[trailer], routeId: ids.routeDar,
    plannedStart: '2026-11-03T06:00:00.000Z', productId: ids.diesel,
  }), 201);
}

async function fundAndDispatch(trip: { id: string }) {
  const f = ok(await as(ops).get(`/trips/${trip.id}/funding`));
  const fuel = ok(await as(ops).post('/fund-requests', { tripId: trip.id, kind: 'fuel', litres: f.fuel.suggested }), 201);
  const cash = ok(await as(ops).post('/fund-requests', { tripId: trip.id, kind: 'cash', amount: { amountMinor: f.cash.suggestedMinor, currencyId: ids.ZMW } }), 201);
  ok(await as(fin).post(`/fund-requests/${fuel.id}/decide`, { approve: true }));
  ok(await as(fin).post(`/fund-requests/${cash.id}/decide`, { approve: true }));
  ok(await as(fin).post(`/fund-requests/${fuel.id}/issue`, { paymentMethodId: ids.pmDepot, reference: 'DP-1', station: 'Lusaka fuel depot' }));
  ok(await as(fin).post(`/fund-requests/${cash.id}/issue`, { paymentMethodId: ids.pmCash }));
  return { f, fuel, cash, trip: ok(await as(ops).post(`/trips/${trip.id}/dispatch`)) };
}

const driverSends = (driver: string, body: Record<string, unknown>) => as(ops).post('/whatsapp/simulate', { driverId: ids[driver], ...body });

before(startDatabase);
after(stopDatabase);
beforeEach(async () => { await resetDatabase(); await setUp(); });

describe('a fuel trip from plan to settlement', () => {
  test('every desk does its step and the figures match the mock', async () => {
    const trip = await newTrip();
    assert.match(trip.number, /^TRIP\/\d{2}\/0001$/);
    assert.deepEqual(trip.stops.map((s: { kind: string }) => s.kind), ['start', 'load', 'border', 'offload', 'end']);
    assert.equal(trip.fuelBudgetL, 1665, 'fuel from distance, the truck\'s consumption and the fuel norm reserve');
    assert.equal(trip.cashBudget.amountMinor, 5340_00, 'cash from the route\'s trip budget');
    assert.equal(trip.openingFuelL, 200);
    assert.equal(trip.state, 'planned');

    const { f } = await fundAndDispatch(trip);
    assert.equal(f.fuel.suggested, 700, 'never more than the tank takes');
    assert.equal(f.cash.suggestedMinor, 5340_00);
    const states = ok(await as(ops).get('/vehicle-states'));
    assert.equal(states.find((s: { vehicleId: string }) => s.vehicleId === ids.v1).fuelL, 900, 'issued fuel goes into the tank');

    const onRoad = ok(await as(ops).get(`/trips/${trip.id}`));
    assert.equal(onRoad.state, 'on_road');
    assert.equal(onRoad.openingFuelL, 200, 'opening fuel excludes fuel issued for this trip');

    // The truck can't pass the loading point before the load is recorded.
    const held = ok(await as(ops).post(`/trips/${trip.id}/position`, { km: 2500, speed: 70, source: 'simulator' }));
    assert.equal(held.tracking.km, 1961);
    assert.ok(held.stops[1].arrivedAt, 'loading point stamped');

    const loadingDoc = ok(await driverSends('d1', {
      kind: 'loading', file: { name: 'invoice.jpg', mime: 'image/jpeg', sampleId: 'loading:1:0' },
      reading: { docNo: 'INV-41234', productId: ids.diesel, qty: 38000, ambientL: 38000, tempC: 28, density: 835, consignor: 'Kurasini Oil Jetty Terminal' },
    }), 201);
    assert.equal(loadingDoc.channel, 'whatsapp');
    const opsInbox = ok(await as(ops).get('/messages', { thread: 'queue:consignments' }));
    const prompt = opsInbox.find((m: { refId?: string }) => m.refId === loadingDoc.id);
    assert.equal(prompt.buttons[0].action.type, 'load.record', 'Operations is offered the loading from the photo');

    const load = ok(await as(ops).post('/consignments', { ...prompt.buttons[0].action, type: undefined }), 201);
    assert.equal(load.load.std20L, Math.round(38000 * load.load.vcf), '20 °C volume from the VCF');
    assert.ok(load.load.vcf < 1 && load.load.vcf > 0.99);
    assert.equal(ok(await as(ops).get(`/driver-documents/${loadingDoc.id}`)).status, 'recorded');
    await as(ops).post('/consignments', { tripId: trip.id, productId: ids.diesel, invoiceNo: 'X', qty: 10, tempC: 20, density: 835 }).expect(409);

    ok(await as(ops).post(`/trips/${trip.id}/position`, { km: 3000, speed: 70, source: 'simulator' }));
    const atOffload = ok(await as(ops).post(`/trips/${trip.id}/position`, { km: 9999, speed: 70, source: 'simulator' }));
    assert.equal(atOffload.tracking.km, 1961 + 934 + 1027, 'held at offloading until delivery');

    // Delivered 0.5 % less at 20 °C than loaded: 0.2 % beyond the 0.3 % allowance.
    const delivered20 = Math.round(load.load.std20L * 0.995);
    ok(await driverSends('d1', { kind: 'delivery', file: { name: 'pod.jpg', mime: 'image/jpeg', sampleId: 'delivery:1:0' }, reading: { docNo: 'POD-55120', qty: 37800, ambientL: 37800, tempC: 20, density: 835, certStd20L: delivered20 } }), 201);
    const delivery = ok(await as(ops).post(`/consignments/${load.id}/delivery`, { podNo: 'POD-55120', qty: 37800, ambientL: 37800, tempC: 20, density: 835, certStd20L: delivered20 }));
    const s = delivery.shortage;
    assert.equal(s.lossL, load.load.std20L - delivered20);
    assert.equal(s.allowanceL, Math.round(load.load.std20L * 0.003));
    assert.equal(s.netShortL, s.lossL - s.allowanceL);
    assert.equal(s.baseAmountMinor, s.netShortL * 31_00, 'priced per litre from the product');
    assert.equal(s.status, 'pending');
    await as(ops).post(`/consignments/${load.id}/shortage-decision`, { charge: true }).expect(403);
    ok(await as(fin).post(`/consignments/${load.id}/shortage-decision`, { charge: true }));

    const receipt = ok(await driverSends('d1', { kind: 'expense', file: { name: 'toll.jpg', mime: 'image/jpeg', sampleId: 'expense:1:toll' }, reading: { docNo: 'R12345', amount: 250, currencyCode: 'ZMW', categoryId: ids.ecRoad } }), 201);
    const finInbox = ok(await as(fin).get('/messages', { thread: 'queue:expense-approvals' }));
    assert.equal(finInbox.find((m: { refId?: string }) => m.refId === receipt.id).buttons[0].action.type, 'expense.record');
    const expense = ok(await as(fin).post('/expenses', { driverId: ids.d1, tripId: trip.id, categoryId: ids.ecRoad, amount: { amountMinor: 250_00, currencyId: ids.ZMW }, receiptNo: 'R12345', docId: receipt.id }), 201);
    assert.equal(expense.status, 'approved', 'Finance approves what it records');

    await as(ops).post(`/trips/${trip.id}/end`, { closingFuelL: 1000 }).expect(422);
    const ended = ok(await as(ops).post(`/trips/${trip.id}/end`, { closingFuelL: 120 }));
    assert.equal(ended.state, 'ended');
    assert.ok(ended.stops.every((st: { arrivedAt?: string }) => st.arrivedAt), 'every stop has a time');
    const v1 = ok(await as(ops).get('/vehicle-states')).find((x: { vehicleId: string }) => x.vehicleId === ids.v1);
    assert.deepEqual([v1.placeId, v1.fuelL], [ids.depot, 120], 'the truck is free where the trip ended');

    ok(await as(ops).post(`/driver-accounts/${ids.d1}/settlement-request`));
    const account = ok(await as(fin).get(`/driver-accounts/${ids.d1}`));
    const expected = 5340_00 + s.baseAmountMinor - 250_00;
    assert.equal(account.balanceMinor, expected, 'advance + shortage − expense');
    assert.deepEqual(account.unsettledTrips.map((t: { id: string }) => t.id), [trip.id]);
    assert.ok(account.settleRequestedAt);

    await as(fin).post('/settlements', { driverId: ids.d1, tripIds: [trip.id], cashMinor: expected + 1 }).expect(422);
    const settlement = ok(await as(fin).post('/settlements', { driverId: ids.d1, tripIds: [trip.id], cashMinor: expected }), 201);
    assert.deepEqual([settlement.openingMinor, settlement.advancesMinor, settlement.expensesMinor, settlement.shortagesMinor, settlement.closingMinor], [0, 5340_00, 250_00, s.baseAmountMinor, 0]);
    assert.equal(ok(await as(fin).get(`/trips/${trip.id}`)).state, 'settled');
    assert.equal(ok(await as(fin).get(`/driver-accounts/${ids.d1}`)).balanceMinor, 0);
    await as(fin).post('/settlements', { driverId: ids.d1, tripIds: [trip.id], cashMinor: 0 }).expect(409);

    const sheet = ok(await as(viewer).get(`/trips/${trip.id}/sheet`));
    assert.equal(sheet.consignments.length, 1);
    assert.equal(sheet.requests.length, 2);
    const statement = ok(await as(viewer).get(`/settlements/${settlement.id}/statement`));
    assert.equal(statement.lines.length, 4, 'advance, expense, shortage and the cash returned');

    const driverThread = ok(await as(ops).get('/messages', { thread: `driver:${ids.d1}` })).map((m: { title?: string }) => m.title).filter(Boolean);
    for (const title of ['New trip TRIP', 'Fuel issued', 'Advance paid', 'On your way', "You've reached", 'Loading confirmed', 'Delivery confirmed', 'Fuel shortage charged', 'Expense approved', 'closed', 'Settlement']) {
      assert.ok(driverThread.some((t: string) => t.includes(title)), `driver was not told: ${title}`);
    }
    const activity = ok(await as(viewer).get('/activity', { tripId: trip.id }));
    assert.ok(activity.length >= 12);
  });
});

describe('money requests', () => {
  test('above the suggestion: a reason, then every level of the approval policy (Finance, then the owner)', async () => {
    const trip = await newTrip();
    const f = ok(await as(ops).get(`/trips/${trip.id}/funding`));
    const amount = { amountMinor: f.cash.suggestedMinor + 1000_00, currencyId: ids.ZMW };
    assert.equal(errorCode(await as(ops).post('/fund-requests', { tripId: trip.id, kind: 'cash', amount })), 'VALIDATION_ERROR');
    const request = ok(await as(ops).post('/fund-requests', { tripId: trip.id, kind: 'cash', amount, reason: 'Extra border fees' }), 201);
    assert.equal(request.overBudget, true);
    await as(ops).post(`/fund-requests/${request.id}/decide`, { approve: true }).expect(403);
    assert.deepEqual(request.approval.levels.map((l: { thread: string }) => l.thread), ['role:finance', 'role:owner'], 'above budget every level approves');
    const afterFinance = ok(await as(fin).post(`/fund-requests/${request.id}/decide`, { approve: true }));
    assert.deepEqual([afterFinance.status, afterFinance.approval.current], ['pending', 1]);
    await as(fin).post(`/fund-requests/${request.id}/decide`, { approve: true }).expect(403);
    await as(fin).get('/messages', { thread: 'role:owner' }).expect(403);
    const ownerInbox = ok(await as(owner).get('/messages', { thread: 'role:owner' }));
    assert.ok(ownerInbox.some((m: { refId?: string; buttons?: unknown[] }) => m.refId === request.id && m.buttons?.length));
    assert.equal(ok(await as(owner).post(`/fund-requests/${request.id}/decide`, { approve: true })).status, 'approved');
    assert.equal(ok(await as(owner).get('/messages', { thread: 'role:owner' })).find((m: { refId?: string }) => m.refId === request.id).resolved, 'Approved by Owner');
    assert.deepEqual(ok(await as(fin).get(`/fund-requests/${request.id}`)).trail.map((t: { what: string }) => t.what), ['requested', 'sent to owner', 'approved']);
  });

  test('USD advances are converted at the rate on the day they are paid', async () => {
    const trip = await newTrip();
    const request = ok(await as(ops).post('/fund-requests', { tripId: trip.id, kind: 'cash', amount: { amountMinor: 100_00, currencyId: ids.USD } }), 201);
    ok(await as(fin).post(`/fund-requests/${request.id}/decide`, { approve: true }));
    const paid = ok(await as(fin).post(`/fund-requests/${request.id}/issue`, { paymentMethodId: ids.pmCash }));
    assert.equal(paid.baseAmountMinor, 2645_00, '100 USD at 26.45');
    assert.equal(ok(await as(fin).get(`/driver-accounts/${ids.d1}`)).balanceMinor, 2645_00);
  });

  test('rejecting needs a reason; paying needs approval; open requests block dispatch; cancelling the trip cancels them', async () => {
    const trip = await newTrip();
    const request = ok(await as(ops).post('/fund-requests', { tripId: trip.id, kind: 'fuel', litres: 100 }), 201);
    await as(fin).post(`/fund-requests/${request.id}/issue`, { paymentMethodId: ids.pmDepot, reference: 'X' }).expect(409);
    await as(fin).post(`/fund-requests/${request.id}/decide`, { approve: false }).expect(422);
    assert.match((await as(ops).post(`/trips/${trip.id}/dispatch`)).body.error.message, /Finance still has to approve/);
    await as(ops).post('/fund-requests', { tripId: trip.id, kind: 'fuel', litres: 601 }).expect(422);
    ok(await as(fin).post(`/fund-requests/${request.id}/decide`, { approve: true }));
    assert.match((await as(fin).post(`/fund-requests/${request.id}/issue`, { paymentMethodId: ids.pmCash })).body.error.message, /not used for fuel/);
    ok(await as(ops).post(`/trips/${trip.id}/cancel`, { reason: 'Customer postponed' }));
    assert.equal(ok(await as(ops).get(`/fund-requests/${request.id}`)).status, 'cancelled');
    await as(ops).post(`/trips/${trip.id}/dispatch`).expect(409);
  });

  test('two Finance approvals of one request: exactly one wins', async () => {
    const trip = await newTrip();
    const request = ok(await as(ops).post('/fund-requests', { tripId: trip.id, kind: 'fuel', litres: 100 }), 201);
    const results = await Promise.all(Array.from({ length: 6 }, () => as(fin).post(`/fund-requests/${request.id}/decide`, { approve: true })));
    assert.equal(results.filter((r) => r.status === 200).length, 1, results.map((r) => r.status).join(','));
    assert.ok(results.every((r) => r.status === 200 || r.status === 409));
  });
});

describe('trips', () => {
  test('a truck, trailer or driver is on one trip at a time, even when created together', async () => {
    ok(await as(ops).put(`/vehicle-states/${ids.v1}`, { placeId: ids.depot, fuelL: 200 }));
    const body = { customerId: ids.zambezi, vehicleId: ids.v1, driverId: ids.d1, routeId: ids.routeDar, plannedStart: '2026-11-03T06:00:00.000Z' };
    const results = await Promise.all(Array.from({ length: 8 }, () => as(ops).post('/trips', body)));
    assert.equal(results.filter((r) => r.status === 201).length, 1, results.map((r) => r.status).join(','));
    ok(await as(ops).put(`/vehicle-states/${ids.v2}`, { placeId: ids.depot }));
    assert.match((await as(ops).post('/trips', { ...body, vehicleId: ids.v2 })).body.error.message, /Joseph Mwansa is already on a trip/);
  });

  test('a trip starts where the truck is, and only a customer can be the customer', async () => {
    ok(await as(ops).put(`/vehicle-states/${ids.v2}`, { placeId: ids.ndola }));
    const res = await as(ops).post('/trips', { customerId: ids.zambezi, vehicleId: ids.v2, stops: [{ placeId: ids.depot, kind: 'start' }, { placeId: ids.darPort, kind: 'load' }, { placeId: ids.depot, kind: 'offload' }, { placeId: ids.depot, kind: 'end' }], plannedStart: '2026-11-03T06:00:00.000Z' });
    assert.match(res.body.error.message, /BCA 9034 is at Ndola yard/);
    const fromRoute = ok(await as(ops).post('/trips', { customerId: ids.zambezi, vehicleId: ids.v2, routeId: ids.routeDar, plannedStart: '2026-11-03T06:00:00.000Z' }), 201);
    assert.equal(fromRoute.stops[0].placeId, ids.ndola, 'the route starts from the truck');
    assert.ok(fromRoute.stops[1].legKm > 1000, 'an unknown leg is estimated from the map');
    assert.match((await as(ops).post('/trips', { customerId: ids.leasing, vehicleId: ids.v1, plannedStart: '2026-11-03T06:00:00.000Z' })).body.error.message, /not a customer/);
  });

  test('the plan is editable until dispatch, with the version it was loaded at', async () => {
    const trip = await newTrip();
    await as(ops).patch(`/trips/${trip.id}`, { version: trip.version + 1, fuelBudgetL: 100 }).expect(409);
    const edited = ok(await as(ops).patch(`/trips/${trip.id}`, { version: trip.version, fuelBudgetL: 1500, driverId: ids.d2 }));
    assert.deepEqual([edited.fuelBudgetL, edited.driverId], [1500, ids.d2]);
    await fundAndDispatch(edited);
    await as(ops).patch(`/trips/${trip.id}`, { version: edited.version + 3, fuelBudgetL: 1 }).expect(409);
    await as(ops).post(`/trips/${trip.id}/cancel`, { reason: 'x' }).expect(409);
  });

  test('roles: Operations plans, Finance pays, Viewer only reads', async () => {
    ok(await as(ops).put(`/vehicle-states/${ids.v1}`, { placeId: ids.depot }));
    const body = { customerId: ids.zambezi, vehicleId: ids.v1, routeId: ids.routeDar, plannedStart: '2026-11-03T06:00:00.000Z' };
    await as(fin).post('/trips', body).expect(403);
    await as(viewer).post('/trips', body).expect(403);
    const trip = ok(await as(ops).post('/trips', body), 201);
    await as(ops).post(`/trips/${trip.id}/dispatch`).expect(422);
    await as(viewer).get(`/trips/${trip.id}`).expect(200);
    await as(viewer).get('/dashboards/finance').expect(200);
    await as(fin).post('/fund-requests', { tripId: trip.id, kind: 'fuel', litres: 10 }).expect(403);
  });
});

describe('nominations', () => {
  test('save, send, the customer accepts, and each truck becomes a trip', async () => {
    ok(await as(ops).put(`/vehicle-states/${ids.v1}`, { placeId: ids.depot }));
    ok(await as(ops).put(`/vehicle-states/${ids.v2}`, { placeId: ids.ndola }));
    const body = { customerId: ids.copper, orderSourceId: ids.broker, loadingPlaceId: ids.ndola, productId: ids.copperCathode, qtyPerTruck: 30, requiredDate: '2026-11-05', trucks: [{ vehicleId: ids.v1 }, { vehicleId: ids.v2, driverId: ids.d2 }] };
    assert.match((await as(ops).post('/nominations', body)).body.error.message, /reference/);
    const nomination = ok(await as(ops).post('/nominations', { ...body, reference: 'BRK-001' }), 201);
    assert.equal(nomination.status, 'draft');
    await as(ops).post(`/nominations/${nomination.id}/accept`, {}).expect(409);
    ok(await as(ops).post(`/nominations/${nomination.id}/send`));
    const thread = ok(await as(ops).get('/messages', { thread: `customer:${ids.copper}` }));
    assert.deepEqual(thread[0].rows.map((r: string[]) => r[0]), ['ALC 4821', 'BCA 9034']);
    assert.match(thread[0].rows[0][1], /Joseph Mwansa/, 'the truck\'s assigned driver');
    ok(await as(ops).post(`/nominations/${nomination.id}/accept`, { customerReply: true }));
    await as(ops).post(`/nominations/${nomination.id}/convert`, {}).expect(422);
    const converted = ok(await as(ops).post(`/nominations/${nomination.id}/convert`, { offloadPlaceId: ids.depot }));
    assert.equal(converted.status, 'converted');
    assert.equal(converted.tripIds.length, 2);
    const trips = ok(await as(ops).get('/trips', { nominationId: nomination.id }));
    assert.deepEqual(trips.map((t: { driverId: string }) => t.driverId).sort(), [ids.d1, ids.d2].sort());
    assert.ok(trips.every((t: { stops: Array<{ kind: string; placeId: string }> }) => t.stops[1]!.placeId === ids.ndola && t.stops[1]!.kind === 'load'));
    await as(ops).post(`/nominations/${nomination.id}/cancel`).expect(409);
  });

  test('a busy truck stops the conversion before any trip is created', async () => {
    await newTrip();
    ok(await as(ops).put(`/vehicle-states/${ids.v2}`, { placeId: ids.ndola }));
    const n = ok(await as(ops).post('/nominations', { customerId: ids.zambezi, loadingPlaceId: ids.darPort, requiredDate: '2026-11-05', trucks: [{ vehicleId: ids.v2, driverId: ids.d2 }, { vehicleId: ids.v1 }] }), 201);
    ok(await as(ops).post(`/nominations/${n.id}/send`));
    ok(await as(ops).post(`/nominations/${n.id}/accept`, {}));
    assert.match((await as(ops).post(`/nominations/${n.id}/convert`, { offloadPlaceId: ids.depot })).body.error.message, /ALC 4821 is already on a trip/);
    assert.equal(ok(await as(ops).get('/trips', { nominationId: n.id })).length, 0);
  });
});

describe('documents, expenses and settlement rules', () => {
  test('returned documents ask the driver again; receipts must be checked before settling', async () => {
    const trip = await newTrip();
    await fundAndDispatch(trip);
    const doc = ok(await driverSends('d1', { kind: 'loading', text: 'Blurry, sorry' }), 201);
    await as(ops).post(`/driver-documents/${doc.id}/return`, {}).expect(422);
    ok(await as(ops).post(`/driver-documents/${doc.id}/return`, { reason: 'The figures are cut off' }));
    await as(ops).post(`/driver-documents/${doc.id}/return`, { reason: 'again' }).expect(409);
    const last = ok(await as(ops).get('/messages', { thread: `driver:${ids.d1}` })).at(-1);
    assert.equal(last.buttons[0].attach, 'loading');

    ok(await as(ops).post('/consignments', { tripId: trip.id, productId: ids.diesel, invoiceNo: 'INV-1', qty: 30000, tempC: 25, density: 835 }), 201);
    const c = ok(await as(ops).get('/consignments', { tripId: trip.id }))[0];
    ok(await as(ops).post(`/consignments/${c.id}/delivery`, { podNo: 'POD-1', qty: 30000, tempC: 25, density: 835 }));
    assert.equal(ok(await as(ops).get(`/consignments/${c.id}`)).shortage.status, 'none');
    const pending = ok(await as(ops).post('/expenses', { driverId: ids.d1, tripId: trip.id, categoryId: ids.ecRoad, amount: { amountMinor: 100_00, currencyId: ids.ZMW } }), 201);
    assert.equal(pending.status, 'pending', 'Operations records, Finance approves');
    ok(await driverSends('d1', { kind: 'expense', file: { name: 'r.jpg', mime: 'image/jpeg', sampleId: 'expense:1:meals' } }), 201);
    ok(await as(ops).post(`/trips/${trip.id}/end`, { closingFuelL: 100 }));
    assert.match((await as(fin).post('/settlements', { driverId: ids.d1, tripIds: [trip.id], cashMinor: 0 })).body.error.message, /Decide the expenses/);
    await as(ops).post(`/expenses/${pending.id}/decide`, { approve: true }).expect(403);
    await as(fin).post(`/expenses/${pending.id}/decide`, { approve: false }).expect(422);
    ok(await as(fin).post(`/expenses/${pending.id}/decide`, { approve: false, reason: 'No receipt' }));
    assert.match((await as(fin).post('/settlements', { driverId: ids.d1, tripIds: [trip.id], cashMinor: 0 })).body.error.message, /unchecked receipt/);
  });
});

describe('desks, sync and WhatsApp', () => {
  test('dashboards and the sync read', async () => {
    const all = ok(await as(ops).get('/operations/sync'));
    const trip = await newTrip();
    const changed = ok(await as(ops).get('/operations/sync', { since: all.serverTime }));
    assert.deepEqual(changed.trips.map((t: { id: string }) => t.id), [trip.id]);
    assert.ok(changed.messages.length >= 1 && changed.vehicleStates.length === 1 && changed.activity.length >= 1);
    ok(await as(ops).post('/fund-requests', { tripId: trip.id, kind: 'fuel', litres: 50 }), 201);
    assert.equal(ok(await as(fin).get('/dashboards/finance')).toApprove.requests.length, 1);
    const ownerView = ok(await as(owner).get('/dashboards/owner'));
    assert.deepEqual([ownerView.fleet.trucks, ownerView.fleet.onTrip, ownerView.trips.planned], [2, 1, 1]);
    const threads = ok(await as(fin).get('/messages/threads'));
    assert.ok(threads.find((t: { thread: string }) => t.thread === 'role:finance').unread >= 1);
    ok(await as(fin).post('/messages/read', { thread: 'role:finance' }));
    assert.equal(ok(await as(fin).get('/messages/threads')).find((t: { thread: string }) => t.thread === 'role:finance').unread, 0);
    const reply = ok(await as(fin).post('/messages', { thread: 'role:finance', text: 'What is waiting?' }), 201);
    assert.equal(reply.at(-1).buttons.length, 1, 'the approval thread lists the open request');
  });

  test('the webhook files driver photos and runs only buttons it sent, once, as the person it sent them to', async () => {
    const secret = 'test-webhook-secret-0123456789';
    await api().post('/api/v1/whatsapp/inbound').send({ from: '+260971234567', text: 'hello' }).expect(503);
    env.MARICHI_TALKS_WEBHOOK_SECRET = secret;
    try {
      await api().post('/api/v1/whatsapp/inbound').set('X-Webhook-Secret', 'wrong').send({ from: '+260971234567', text: 'hi' }).expect(403);
      const trip = await newTrip();
      const filed = ok(await api().post('/api/v1/whatsapp/inbound').set('X-Webhook-Secret', secret).send({ from: '+260971234567', text: 'Arrived at the port' }));
      assert.equal(filed.handled, 'driver-document');
      assert.equal(ok(await as(ops).get(`/driver-documents/${filed.id}`)).tripId, trip.id);
      const sent: OutboundWhatsApp[] = [];
      setWhatsAppTransport(async (m) => { sent.push(m); return { channel: 'whatsapp', to: m.to, status: 'logged' }; });
      ok(await as(fin).patch('/auth/me', { phone: '+260966000111' }));
      const request = ok(await as(ops).post('/fund-requests', { tripId: trip.id, kind: 'fuel', litres: 100 }), 201);
      const toFinance = sent.find((m) => m.to === '+260966000111')!;
      assert.deepEqual(toFinance.buttons, ['Approve', 'Reject'], 'the policy level sends approvals on WhatsApp');
      const approve = toFinance.tokens![0]!;
      const inbound = (body: object) => api().post('/api/v1/whatsapp/inbound').set('X-Webhook-Secret', secret).send(body);
      await inbound({ from: '+260971234567', buttonToken: approve }).expect(422);
      await inbound({ from: '+260955000000', buttonToken: approve }).expect(403);
      await inbound({ from: '+260966000111', buttonToken: 'x'.repeat(32) }).expect(403);
      const answered = ok(await inbound({ from: '+260966000111', buttonToken: approve }));
      assert.equal(answered.result.status, 'approved');
      await inbound({ from: '+260966000111', buttonToken: approve }).expect(403);
      assert.equal(ok(await as(fin).get(`/fund-requests/${request.id}`)).trail.at(-1).via, 'whatsapp');
      assert.equal(ok(await api().post('/api/v1/whatsapp/inbound').set('X-Webhook-Secret', secret).send({ from: '+19995550000', text: '?' })).handled, 'ignored');
    } finally {
      env.MARICHI_TALKS_WEBHOOK_SECRET = undefined;
      setWhatsAppTransport(async (m) => ({ channel: 'whatsapp', to: m.to, status: 'logged' }));
    }
  });
});

describe('configuration, not code', () => {
  const company = async () => ok(await as(owner).get('/company'));
  const setCompany = async (change: Record<string, unknown>) => ok(await as(owner).put('/company', { ...change, version: (await company()).version }));

  test('a trip follows its type\'s stages; a manual stage holds it until its actor completes it', async () => {
    const fuelType = (await find(owner, 'trip-types', 'FUEL')).id;
    const plan = (await as(owner).get('/trip-stages', { tripTypeId: fuelType, sort: 'order' })).body.data;
    // The company adds an inspection, done by Operations, between funding and loading.
    const loading = plan.find((s: { code: string }) => s.code === 'LOADING');
    const later = plan.filter((s: { order: number }) => s.order >= loading.order).sort((a: { order: number }, b: { order: number }) => b.order - a.order);
    for (const s of later) ok(await as(owner).patch(`/trip-stages/${s.id}`, { version: s.version, order: s.order + 1 }));
    const opsRole = (await as(owner).get('/roles', { search: 'operations' })).body.data.find((r: { key: string }) => r.key === 'operations');
    ok(await as(owner).post('/trip-stages', { tripTypeId: fuelType, code: 'INSPECT', name: 'Tanker inspection', order: loading.order, actorRoleId: opsRole.id, completesOn: 'manual' }), 201);

    const trip = await newTrip();
    assert.deepEqual(trip.stages.map((s: { code: string }) => s.code), ['PLAN', 'FUNDING', 'INSPECT', 'LOADING', 'TRANSIT', 'OFFLOAD', 'CLOSE']);
    assert.equal(trip.stage.code, 'PLAN');
    await fundAndDispatch(trip);
    const atInspection = ok(await as(ops).get(`/trips/${trip.id}`));
    assert.equal(atInspection.stage.code, 'INSPECT', 'funding and dispatch completed PLAN and FUNDING');
    const load = { tripId: trip.id, productId: ids.diesel, invoiceNo: 'INV-1', qty: 30000, tempC: 25, density: 835 };
    assert.match((await as(ops).post('/consignments', load)).body.error.message, /Complete "Tanker inspection" first/);
    await as(fin).post(`/trips/${trip.id}/stages/complete`).expect(422);
    assert.equal(ok(await as(ops).post(`/trips/${trip.id}/stages/complete`)).stage.code, 'LOADING');
    ok(await as(ops).post('/consignments', load), 201);
    assert.equal(ok(await as(ops).get(`/trips/${trip.id}`)).stage.code, 'TRANSIT');
  });

  test('a company that switches a module off loses that area', async () => {
    const trip = await newTrip();
    await setCompany({ modules: ['masters', 'trips'] });
    assert.match((await as(ops).post('/fund-requests', { tripId: trip.id, kind: 'fuel', litres: 10 })).body.error.message, /Finance module is switched off/);
    await as(ops).get('/driver-accounts').expect(403);
    ok(await as(ops).post(`/trips/${trip.id}/dispatch`));
    await as(ops).post(`/trips/${trip.id}/position`, { km: 10, speed: 50, source: 'simulator' }).expect(403);
    await setCompany({ modules: ['masters'] });
    await as(ops).get('/trips').expect(403);
  });

  test('trip settings: a company whose trips need not start from the truck', async () => {
    ok(await as(ops).put(`/vehicle-states/${ids.v2}`, { placeId: ids.ndola }));
    const stops = [{ placeId: ids.depot, kind: 'start' }, { placeId: ids.darPort, kind: 'load' }, { placeId: ids.depot, kind: 'offload' }, { placeId: ids.depot, kind: 'end' }];
    const body = { customerId: ids.zambezi, vehicleId: ids.v2, stops, plannedStart: '2026-11-03T06:00:00.000Z' };
    await as(ops).post('/trips', body).expect(422);
    const saved = await setCompany({ operations: { tripStartsFromTruck: false, roadDistanceFactor: 1.5 } });
    assert.equal(saved.operations.averageSpeedKmh, 62, 'saving some settings keeps the others');
    ok(await as(ops).post('/trips', body), 201);
  });

  test('approval levels can count litres, and a custom role sees only the work its permissions allow', async () => {
    const policy = await find(owner, 'approval-policies', 'FUEL-L');
    assert.equal(policy.levels[0].measure, 'litres');
    const trip = await newTrip();
    const big = ok(await as(ops).post('/fund-requests', { tripId: trip.id, kind: 'fuel', litres: 600 }), 201);
    assert.equal(big.approval.levels.length, 1, '600 L is under the owner\'s 5,000 L level');

    const role = ok(await as(owner).post('/roles', { key: 'dispatcher', name: 'Dispatcher', permissions: [{ resource: '*', actions: ['read'] }, { resource: 'trips', actions: ['create', 'update'] }, { resource: 'messages', actions: ['create'] }] }), 201);
    const email = `dispatcher.${Date.now()}@example.test`;
    ok(await as(owner).post('/users', { name: 'Dina Dispatcher', email, password: 'Passw0rd!', roleIds: [role.id] }), 201);
    const login = await api().post('/api/v1/auth/login').send({ email, password: 'Passw0rd!' });
    const dispatcher = { token: login.body.data.accessToken } as Session;
    const seen = ok(await as(dispatcher).get('/operations/sync')).messages.map((m: { thread: string }) => m.thread);
    assert.ok(seen.every((t: string) => t === 'queue:trips' || /^(driver|customer):/.test(t)), `dispatcher saw ${[...new Set(seen)].join(', ')}`);
    await as(dispatcher).get('/messages', { thread: 'role:finance' }).expect(403);
    await as(dispatcher).post(`/fund-requests/${big.id}/decide`, { approve: true }).expect(403);
  });
});
