// #64: a loaded trip that can't deliver: return the load, move it to another truck, or write it off.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { settleSends } from '../src/modules/messaging/dispatcher.js';
import { OutboundMessage } from '../src/modules/messaging/models/connection.model.js';
import { Trip } from '../src/modules/operations/models/trip.model.js';
import { api, bearer, find, loadSample, resetDatabase, signUp, startDatabase, stopDatabase, userWithRole, type Session } from './helpers.js';

let owner: Session, ops: Session, fin: Session;
const ids: Record<string, string> = {};

const as = (s: { token: string }) => ({
  get: (path: string, query: Record<string, unknown> = {}) => api().get(`/api/v1${path}`).query(query).set(bearer(s)),
  post: (path: string, body: unknown = {}) => api().post(`/api/v1${path}`).set(bearer(s)).send(body as object),
  put: (path: string, body: unknown) => api().put(`/api/v1${path}`).set(bearer(s)).send(body as object),
});
const ok = <T = any>(res: { status: number; body: any }, status = 200): T => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body.data as T;
};

async function setOperations(operations: Record<string, unknown>) {
  const company = ok(await as(owner).get('/company'));
  ok(await as(owner).put('/company', { version: company.version, operations }));
}

/** A truck on the road with its load on board, partway to the offloading point. */
async function loaded() {
  ok(await as(ops).put(`/vehicle-states/${ids.v1}`, { placeId: ids.depot, fuelL: 200 }));
  const trip = ok(await as(ops).post('/trips', { customerId: ids.zambezi, vehicleId: ids.v1, driverId: ids.d1, trailerId: ids.t1, routeId: ids.routeDar, plannedStart: '2026-11-03T06:00:00.000Z', productId: ids.diesel }), 201);
  ok(await as(ops).post(`/trips/${trip.id}/dispatch`));
  ok(await as(ops).post(`/trips/${trip.id}/position`, { km: 1961, speed: 0, source: 'simulator' }));
  const load = ok(await as(ops).post('/consignments', { tripId: trip.id, productId: ids.diesel, invoiceNo: 'INV-1', qty: 38000, ambientL: 38000, tempC: 20, density: 835 }), 201);
  return { trip: ok(await as(ops).get(`/trips/${trip.id}`)), load };
}
const balance = async (driverId: string | undefined) => ok(await as(fin).get(`/driver-accounts/${driverId}`));
const undelivered = (s: Session, tripId: string, body: Record<string, unknown>) => as(s).post(`/trips/${tripId}/undelivered`, { reasonId: ids.accident, ...body });

before(startDatabase);
after(stopDatabase);
beforeEach(async () => {
  await resetDatabase();
  owner = await signUp('Olga Owner');
  await loadSample(owner);
  ops = await userWithRole(owner, 'operations', 'Olivia Ops');
  fin = await userWithRole(owner, 'finance', 'Felix Finance');
  const lookups: Array<[string, string, string]> = [
    ['zambezi', 'parties', 'Zambezi'], ['v1', 'vehicles', 'ALC 4821'], ['v2', 'vehicles', 'BCA 9034'], ['t1', 'trailers', 'TAC 7821'], ['d1', 'drivers', 'Joseph'], ['d2', 'drivers', 'Martha'], ['routeDar', 'routes', 'DAR-LSK'],
    ['depot', 'places', 'LSK-DEPOT'], ['nakonde', 'places', 'NAKONDE'], ['diesel', 'products', 'DIESEL-50'], ['ZMW', 'currencies', 'ZMW'],
  ];
  for (const [key, master, search] of lookups) ids[key] = (await find(owner, master, search)).id;
  ids.accident = (await find(owner, 'cancellation-reasons', 'ACCIDENT')).id;
  await setOperations({ tripStartsFromTruck: false });
});

describe('returning the load', () => {
  test('the trip gets a return leg and is delivered and closed the usual way', async () => {
    const { trip, load } = await loaded();
    const loadStop = trip.stops.find((s: { kind: string }) => s.kind === 'load');
    const decided = ok(await undelivered(ops, trip.id, { outcome: 'return', note: 'Tanker damaged' }));
    assert.equal(decided.undelivered.outcome, 'return');
    assert.equal(decided.undelivered.reason, 'Accident on the road: Tanker damaged');
    const offload = decided.stops.filter((s: { kind: string }) => s.kind === 'offload');
    assert.equal(offload.length, 1);
    assert.equal(offload[0].placeId, loadStop.placeId, 'back to where it was loaded');
    assert.equal(decided.stops.at(-1).kind, 'end');

    ok(await as(ops).post(`/trips/${trip.id}/position`, { km: 99_999, speed: 0, source: 'simulator' }));
    ok(await as(ops).post(`/consignments/${load.id}/delivery`, { podNo: 'RET-1', qty: 38000, ambientL: 38000, tempC: 20, density: 835, certStd20L: load.load.std20L }));
    assert.equal(ok(await as(ops).post(`/trips/${trip.id}/end`, { closingFuelL: 100 })).active, false);

    const entries = ok<any[]>(await as(owner).get('/audit-logs', { entity: 'trips', entityId: trip.id, limit: 50 }));
    assert.ok(entries.some((e) => /going back to .*Accident on the road/.test(e.summary ?? '')));
    await settleSends();
    const mails = await OutboundMessage.find({ event: 'trip.load_returned' }).lean();
    assert.ok(mails.some((m) => m.toName === 'Olivia Ops' && /Accident on the road/.test(m.body)), JSON.stringify(mails.map((m) => m.toName)));
    assert.ok(mails.some((m) => m.toName === 'Zambezi Energy Ltd'), 'the customer hears too');
  });
});

describe('a load refused at its destination', () => {
  test('it can go back from the last stop, but there is nowhere further to move it on another truck', async () => {
    const { trip, load } = await loaded();
    ok(await as(ops).post(`/trips/${trip.id}/position`, { km: 99_999, speed: 0, source: 'simulator' }));
    const there = ok(await as(ops).get(`/trips/${trip.id}`));
    assert.ok(there.stops.find((s: { kind: string }) => s.kind === 'offload').arrivedAt, 'at the offloading point');
    ok(await as(ops).put(`/vehicle-states/${ids.v2}`, { placeId: ids.nakonde, fuelL: 300 }));
    assert.match((await undelivered(ops, trip.id, { outcome: 'transfer', vehicleId: ids.v2, closingFuelL: 80 })).body.error.message, /already reached its offloading point/);

    // Every stop reached, the last one included.
    await Trip.updateOne({ _id: trip.id }, { $set: { 'stops.$[].arrivedAt': new Date() } });
    const decided = ok(await undelivered(ops, trip.id, { outcome: 'return', note: 'Refused by the consignee' }));
    assert.equal(decided.stops.filter((s: { kind: string }) => s.kind === 'offload').length, 1);
    assert.equal(decided.stops.filter((s: { kind: string }) => s.kind === 'end').length, 1);
    assert.equal(decided.stops.at(-1).kind, 'end');
    assert.equal(decided.stops.at(-1).arrivedAt, undefined, 'the way back is still to drive');
    ok(await as(ops).post(`/trips/${trip.id}/position`, { km: 100_000, speed: 0, source: 'simulator' }));
    ok(await as(ops).post(`/consignments/${load.id}/delivery`, { podNo: 'RET-2', qty: 38000, ambientL: 38000, tempC: 20, density: 835, certStd20L: load.load.std20L }));
    assert.equal(ok(await as(ops).post(`/trips/${trip.id}/end`, { closingFuelL: 100 })).active, false);
  });
});

describe('moving it to another truck', () => {
  test('a new trip carries the same consignment and its measurements; the old trip closes and frees its truck', async () => {
    const { trip, load } = await loaded();
    ok(await as(ops).put(`/vehicle-states/${ids.v2}`, { placeId: ids.nakonde, fuelL: 300 }));
    const created = ok(await undelivered(ops, trip.id, { outcome: 'transfer', vehicleId: ids.v2, driverId: ids.d2, placeId: ids.nakonde, closingFuelL: 80 }));
    assert.equal(created.vehicleId, ids.v2);
    assert.equal(created.transferredFromTripId, trip.id);
    assert.deepEqual(created.stops.slice(0, 2).map((s: { kind: string; placeId: string }) => [s.kind, s.placeId]), [['start', ids.nakonde], ['load', ids.nakonde]]);

    const moved = ok(await as(ops).get(`/consignments/${load.id}`));
    assert.equal(moved.tripId, created.id);
    assert.equal(moved.load.std20L, load.load.std20L, 'the measurements go with it');
    assert.equal(moved.transfers[0].fromTripId, trip.id);

    const closed = ok(await as(ops).get(`/trips/${trip.id}`));
    assert.equal(closed.active, false);
    assert.equal(closed.undelivered.outcome, 'transfer');
    assert.equal(closed.transferredToTripId, created.id);
    assert.equal(closed.stopReason, 'Accident on the road');
    ok(await as(ops).put(`/vehicle-states/${ids.v1}`, { placeId: ids.depot, fuelL: 200 }), 200);

    ok(await as(ops).post(`/trips/${created.id}/dispatch`));
    ok(await as(ops).post(`/trips/${created.id}/position`, { km: 99_999, speed: 0, source: 'simulator' }));
    const delivered = ok(await as(ops).post(`/consignments/${load.id}/delivery`, { podNo: 'POD-2', qty: 38000, ambientL: 38000, tempC: 20, density: 835, certStd20L: load.load.std20L }));
    assert.ok(delivered.delivered);
    assert.equal(ok(await as(ops).post(`/trips/${created.id}/end`, { closingFuelL: 100 })).active, false);
    await settleSends();
    assert.ok((await OutboundMessage.countDocuments({ event: 'trip.load_transferred' })) > 0);
  });

  test('before the new truck leaves, its trip cannot be cancelled away from the load, but the office can still decide', async () => {
    const { trip, load } = await loaded();
    ok(await as(ops).put(`/vehicle-states/${ids.v2}`, { placeId: ids.nakonde, fuelL: 300 }));
    const created = ok(await undelivered(ops, trip.id, { outcome: 'transfer', vehicleId: ids.v2, driverId: ids.d2, closingFuelL: 80 }));
    const cancel = await as(ops).post(`/trips/${created.id}/cancel`, { reason: 'Changed our minds' });
    assert.equal(cancel.status, 409);
    assert.match(cancel.body.error.message, /carries a load/);
    const done = ok(await undelivered(owner, created.id, { outcome: 'write_off', amount: { amountMinor: 100_00, currencyId: ids.ZMW }, closingFuelL: 300 }));
    assert.equal(done.id, load.id);
    assert.equal(done.writeOff.status, 'approved');
  });

  test('the same driver can carry on in the other truck; a busy truck is refused and the old trip stays open', async () => {
    const { trip } = await loaded();
    const refused = await undelivered(ops, trip.id, { outcome: 'transfer', vehicleId: ids.v1, closingFuelL: 80 });
    assert.equal(refused.status, 422);
    assert.equal(ok(await as(ops).get(`/trips/${trip.id}`)).active, true);
    ok(await as(ops).put(`/vehicle-states/${ids.v2}`, { placeId: ids.nakonde, fuelL: 300 }));
    const created = ok(await undelivered(ops, trip.id, { outcome: 'transfer', vehicleId: ids.v2, closingFuelL: 80 }));
    assert.equal(created.driverId, ids.d1);
  });
});

describe('writing it off', () => {
  const value = () => ({ amountMinor: 50_000_00, currencyId: ids.ZMW });

  test('charged to the driver: the owner approves, the trip closes, and the driver repays through the account and settlement', async () => {
    const { trip, load } = await loaded();
    const before = (await balance(ids.d1)).balanceMinor as number;
    const asked = ok(await undelivered(ops, trip.id, { outcome: 'write_off', carrier: 'driver', amount: value(), closingFuelL: 90 }));
    assert.equal(asked.writeOff.status, 'pending');
    assert.equal(ok(await as(ops).get(`/trips/${trip.id}`)).active, true, 'nothing happens until the owner decides');
    assert.equal((await undelivered(ops, trip.id, { outcome: 'return' })).status, 409, 'one decision at a time');
    await as(ops).post(`/consignments/${load.id}/write-off-decision`, { approve: true }).expect(403);
    const inbox = ok<any[]>(await as(owner).get('/messages', { thread: 'role:owner', limit: 50 }));
    assert.ok(inbox.some((m) => m.refId === `${load.id}-writeoff` && m.buttons.length === 2));

    const approved = ok(await as(owner).post(`/consignments/${load.id}/write-off-decision`, { approve: true }));
    assert.equal(approved.writeOff.status, 'approved');
    assert.equal(approved.inTransit, false);
    const closed = ok(await as(ops).get(`/trips/${trip.id}`));
    assert.equal(closed.active, false);
    assert.equal(closed.undelivered.outcome, 'write_off');

    const account = await balance(ids.d1);
    assert.equal(account.balanceMinor, before + 50_000_00, 'the driver owes it');
    assert.ok(account.entries.some((e: { kind: string; label: string }) => e.kind === 'write_off' && e.label.includes(load.number)));

    const settlement = ok(await as(fin).post('/settlements', { driverId: ids.d1, tripIds: [trip.id], cashMinor: 0 }), 201);
    assert.equal(settlement.writeOffsMinor, 50_000_00);
    const entries = ok<any[]>(await as(owner).get('/audit-logs', { entity: 'trips', entityId: trip.id, limit: 50 }));
    assert.ok(entries.some((e) => /Wrote off .*carried by the driver/.test(e.summary ?? '')));
    await settleSends();
    assert.ok((await OutboundMessage.countDocuments({ event: 'trip.load_written_off' })) > 0);
  });

  test('carried by the company or claimed from an insurer: nothing goes on the driver', async () => {
    const { trip } = await loaded();
    const before = (await balance(ids.d1)).balanceMinor as number;
    assert.equal((await undelivered(owner, trip.id, { outcome: 'write_off', carrier: 'insurance', amount: value(), closingFuelL: 90 })).status, 422, 'an insurer is needed');
    assert.equal((await undelivered(owner, trip.id, { outcome: 'write_off', carrier: 'insurance', insurerPartyId: ids.zambezi, amount: value(), closingFuelL: 90 })).status, 422, 'a customer is not an insurer');
    const insurer = ok(await as(owner).post('/parties', { name: 'Madison Insurance', roles: ['insurer'] }), 201);
    const done = ok(await undelivered(owner, trip.id, { outcome: 'write_off', carrier: 'insurance', insurerPartyId: insurer.id, claimReference: 'CL-77', amount: value(), closingFuelL: 90 }));
    assert.equal(done.writeOff.status, 'approved', "the owner's own write-off needs nobody's approval");
    assert.equal(done.writeOff.claimReference, 'CL-77');
    assert.equal((await balance(ids.d1)).balanceMinor, before);
  });

  test('rejected, the trip stays open and the office can choose again', async () => {
    const { trip, load } = await loaded();
    ok(await undelivered(ops, trip.id, { outcome: 'write_off', amount: value(), closingFuelL: 90 }));
    assert.equal((await as(owner).post(`/consignments/${load.id}/write-off-decision`, { approve: false })).status, 422, 'a reason is needed');
    const rejected = ok(await as(owner).post(`/consignments/${load.id}/write-off-decision`, { approve: false, note: 'Claim it from the insurer' }));
    assert.equal(rejected.writeOff.status, 'rejected');
    assert.equal(ok(await as(ops).get(`/trips/${trip.id}`)).active, true);
    ok(await undelivered(ops, trip.id, { outcome: 'return' }));
  });

  test('its value comes from the product\'s shortage price unless one is given, and a company can skip the owner', async () => {
    const { trip, load } = await loaded();
    await setOperations({ writeOffNeedsOwner: false });
    const product = ok(await as(owner).get(`/products/${ids.diesel}`));
    const done = ok(await undelivered(ops, trip.id, { outcome: 'write_off', closingFuelL: 90 }));
    assert.equal(done.writeOff.status, 'approved');
    assert.equal(done.writeOff.carrier, 'company', 'the default carrier');
    assert.equal(done.writeOff.amount.amountMinor, Math.round(load.load.std20L * product.shortagePricePerUnit.amountMinor));
  });
});

describe('the settings', () => {
  test('an outcome or a carrier that is switched off is refused', async () => {
    const { trip } = await loaded();
    await setOperations({ loadedTripOutcomes: ['return'], writeOffCarriers: ['company'], writeOffDefaultCarrier: 'company' });
    const off = await undelivered(ops, trip.id, { outcome: 'write_off', closingFuelL: 90 });
    assert.equal(off.status, 422);
    assert.match(off.body.error.message, /does not write loads off/);
    assert.match((await undelivered(ops, trip.id, { outcome: 'transfer', vehicleId: ids.v2, closingFuelL: 90 })).body.error.message, /does not move loads/);

    await setOperations({ loadedTripOutcomes: ['write_off'] });
    const carrier = await undelivered(ops, trip.id, { outcome: 'write_off', carrier: 'driver', amount: { amountMinor: 100, currencyId: ids.ZMW }, closingFuelL: 90 });
    assert.match(carrier.body.error.message, /does not charge write-offs to the driver/);
    assert.match((await undelivered(ops, trip.id, { outcome: 'return' })).body.error.message, /does not return loads/);
  });

  test('only the chosen roles decide; the owner always may', async () => {
    const { trip } = await loaded();
    await setOperations({ loadedTripRoles: ['finance'] });
    const refused = await undelivered(ops, trip.id, { outcome: 'return' });
    assert.equal(refused.status, 403);
    assert.match(refused.body.error.message, /doesn't decide/);
    ok(await undelivered(owner, trip.id, { outcome: 'return' }));
  });

  test('the reason must be a reason for a trip; a trip with nothing loaded is refused', async () => {
    const { trip } = await loaded();
    const order = ok(await as(owner).post('/cancellation-reasons', { code: 'ORDER', name: 'Order only', appliesTo: ['order'] }), 201);
    assert.equal((await undelivered(ops, trip.id, { outcome: 'return', reasonId: order.id })).status, 422);
    ok(await as(ops).put(`/vehicle-states/${ids.v2}`, { placeId: ids.depot, fuelL: 200 }));
    const empty = ok(await as(ops).post('/trips', { customerId: ids.zambezi, vehicleId: ids.v2, driverId: ids.d2, routeId: ids.routeDar, plannedStart: '2026-11-03T06:00:00.000Z' }), 201);
    ok(await as(ops).post(`/trips/${empty.id}/dispatch`));
    assert.equal((await undelivered(ops, empty.id, { outcome: 'return' })).status, 409);
  });

  test('the default is one of those allowed', async () => {
    const company = ok(await as(owner).get('/company'));
    assert.deepEqual(company.operations.loadedTripOutcomes, ['return', 'transfer', 'write_off']);
    assert.equal(company.operations.writeOffNeedsOwner, true);
    assert.equal((await as(owner).put('/company', { version: company.version, operations: { writeOffCarriers: ['company'], writeOffDefaultCarrier: 'driver' } })).status, 422);
  });
});
