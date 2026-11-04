// #63: the Maintenance area: service plans, what is due, work orders that hold a truck, tyres and cost per truck.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { settleSends } from '../src/modules/messaging/dispatcher.js';
import { OutboundMessage } from '../src/modules/messaging/models/connection.model.js';
import { Vehicle } from '../src/modules/fleet/models/vehicle.model.js';
import { ServicePlan } from '../src/modules/maintenance/models/maintenance.model.js';
import { remindDueServices, serviceStatus } from '../src/modules/maintenance/maintenance.service.js';
import { api, bearer, find, loadSample, resetDatabase, signUp, startDatabase, stopDatabase, userWithRole, type Session } from './helpers.js';

let owner: Session, ops: Session, fin: Session;
const ids: Record<string, string> = {};

const as = (s: { token: string }) => ({
  get: (path: string, query: Record<string, unknown> = {}) => api().get(`/api/v1${path}`).query(query).set(bearer(s)),
  post: (path: string, body: unknown = {}) => api().post(`/api/v1${path}`).set(bearer(s)).send(body as object),
  patch: (path: string, body: unknown) => api().patch(`/api/v1${path}`).set(bearer(s)).send(body as object),
  put: (path: string, body: unknown) => api().put(`/api/v1${path}`).set(bearer(s)).send(body as object),
});
const ok = <T = any>(res: { status: number; body: any }, status = 200): T => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body.data as T;
};

async function setAreas(...areas: string[]) {
  const company = ok(await as(owner).get('/company'));
  const base = (company.modules as string[]).filter((m) => !['maintenance', 'parts', 'tyres'].includes(m));
  return ok(await as(owner).put('/company', { version: company.version, modules: [...base, ...areas] }));
}
async function setOdometer(km: number, vehicle = ids.v1) {
  const truck = ok(await as(owner).get(`/vehicles/${vehicle}`));
  ok(await as(owner).patch(`/vehicles/${vehicle}`, { version: truck.version, odometerKm: km }));
}
const plan = (over: Record<string, unknown> = {}) => as(owner).post('/service-plans', { code: 'A', name: 'A service', vehicleId: ids.v1, everyKm: 10_000, ...over });
const rowOf = async (planId: string) => (await serviceStatus()).find((r) => r.planId === planId)!;
const newTrip = () => as(ops).post('/trips', {
  customerId: ids.zambezi, vehicleId: ids.v1, driverId: ids.d1, trailerId: ids.t1, routeId: ids.routeDar, plannedStart: '2026-11-03T06:00:00.000Z', productId: ids.diesel,
});

before(startDatabase);
after(stopDatabase);
beforeEach(async () => {
  await resetDatabase();
  owner = await signUp('Olga Owner');
  await loadSample(owner);
  ops = await userWithRole(owner, 'operations', 'Olivia Ops');
  fin = await userWithRole(owner, 'finance', 'Felix Finance');
  const lookups: Array<[string, string, string]> = [
    ['zambezi', 'parties', 'Zambezi'], ['v1', 'vehicles', 'ALC 4821'], ['t1', 'trailers', 'TAC 7821'], ['d1', 'drivers', 'Joseph'], ['routeDar', 'routes', 'DAR-LSK'],
    ['depot', 'places', 'LSK-DEPOT'], ['diesel', 'products', 'DIESEL-50'], ['ZMW', 'currencies', 'ZMW'], ['USD', 'currencies', 'USD'],
  ];
  for (const [key, master, search] of lookups) ids[key] = (await find(owner, master, search)).id;
  ok(await as(ops).put(`/vehicle-states/${ids.v1}`, { placeId: ids.depot, fuelL: 200 }));
  await Vehicle.updateOne({ _id: ids.v1 }, { $set: { odometerKm: 100_000 } });
  await ServicePlan.deleteMany({}); // only this test's plans, not the sample's
});

describe('the area', () => {
  test('off by default: its masters are hidden and its routes refuse; switched on they appear; switched off the records are kept', async () => {
    const offered = async () => ok<Array<{ key: string }>>(await as(owner).get('/meta/masters')).map((m) => m.key);
    assert.ok(!(await offered()).includes('work-orders'));
    for (const path of ['/work-orders', '/service-plans', '/tyre-records', '/maintenance/services', '/maintenance/held-trucks']) await as(owner).get(path).expect(403);

    await setAreas('maintenance');
    assert.ok((await offered()).includes('work-orders'));
    const order = ok(await as(ops).post('/work-orders', { vehicleId: ids.v1, description: 'Brakes' }), 201);
    await newTrip().expect(409);

    await setAreas();
    await as(owner).get(`/work-orders/${order.id}`).expect(403);
    ok(await newTrip(), 201);
    await setAreas('maintenance');
    assert.equal(ok(await as(owner).get(`/work-orders/${order.id}`)).description, 'Brakes', 'the record came back');
  });

  test('Parts and Tyres sit inside Maintenance, each with its own switch', async () => {
    await setAreas('maintenance');
    const parts = { vehicleId: ids.v1, stopsTruck: false, parts: [{ name: 'Brake pad', quantity: 4, unitCost: { amountMinor: 100_00, currencyId: ids.ZMW } }] };
    assert.equal((await as(ops).post('/work-orders', parts)).status, 422, 'parts are off');
    const form = async () => ok<any[]>(await as(owner).get('/meta/masters')).find((m) => m.key === 'work-orders');
    assert.ok(!(await form()).fields.some((f: { path: string }) => f.path === 'parts'));
    assert.ok(!(await form()).createSchema.properties.parts);
    await as(owner).get('/tyre-records').expect(403);

    await setAreas('maintenance', 'parts', 'tyres');
    assert.ok((await form()).createSchema.properties.parts);
    ok(await as(ops).post('/work-orders', parts), 201);
    ok(await as(owner).get('/tyre-records'));

    // Their switches stay as they were, but nothing inside runs while Maintenance is off.
    await setAreas('parts', 'tyres');
    await as(owner).get('/tyre-records').expect(403);
  });
});

describe('what is due', () => {
  beforeEach(() => setAreas('maintenance'));

  test('a truck past its service km shows as overdue, and a reminder fires once', async () => {
    await setOdometer(100_000);
    const { id } = ok(await plan(), 201);
    let row = await rowOf(id);
    assert.equal(row.health, 'ok');
    assert.equal(row.nextKm, 110_000);

    await setOdometer(109_500);
    row = await rowOf(id);
    assert.equal(row.health, 'due', 'within the 1,000 km the company counts as soon');
    assert.equal(row.reason, '500 km left');
    assert.equal(await remindDueServices(), 1);
    assert.equal(await remindDueServices(), 0, 'once while it is due');

    await setOdometer(111_200);
    row = await rowOf(id);
    assert.equal(row.health, 'overdue');
    assert.equal(row.reason, '1,200 km over');
    assert.equal(await remindDueServices(), 1, 'and once more when it goes overdue');
    assert.equal(await remindDueServices(), 0);

    await settleSends();
    const mails = await OutboundMessage.find({ event: 'service.due' }).lean();
    assert.ok(mails.some((m) => m.toName === 'Olivia Ops' && m.channel === 'email' && /1,200 km over/.test(m.body) && /ALC 4821/.test(m.body)), JSON.stringify(mails.map((m) => m.body)));
    const inbox = ok<any[]>(await as(ops).get('/messages', { thread: 'queue:work-orders' }));
    assert.ok(inbox.some((m) => /A service overdue · ALC 4821/.test(m.title)));

    const list = ok<any[]>(await as(ops).get('/maintenance/services'));
    assert.equal(list[0].health, 'overdue');
  });

  test('a finished service starts the next count; an open one stops the reminders', async () => {
    await setOdometer(100_000);
    const { id } = ok(await plan(), 201);
    await rowOf(id);
    await setOdometer(112_000);
    const order = ok(await as(ops).post('/work-orders', { vehicleId: ids.v1, source: 'service', servicePlanId: id, stopsTruck: false }), 201);
    assert.deepEqual((await rowOf(id)).openWorkOrder, { id: order.id, number: order.number });
    assert.equal(await remindDueServices(), 0, 'it is already in hand');

    ok(await as(ops).patch(`/work-orders/${order.id}`, { version: order.version, stage: 'done' }));
    const row = await rowOf(id);
    assert.equal(row.health, 'ok');
    assert.equal(row.nextKm, 122_000, 'counted from the reading at the service');
    assert.ok(row.lastServiceAt);
    assert.equal(row.openWorkOrder, undefined);

    await setOdometer(123_000);
    assert.equal(await remindDueServices(), 1, 'the next cycle reminds again');
  });

  test('days and engine hours count too, whichever comes first', async () => {
    const truck = ok(await as(owner).get(`/vehicles/${ids.v1}`));
    ok(await as(owner).patch(`/vehicles/${ids.v1}`, { version: truck.version, odometerKm: 100_000, engineHours: 5000 }));
    const { id } = ok(await plan({ everyDays: 30, everyEngineHours: 500 }), 201);
    await rowOf(id);
    const later = (days: number) => new Date(Date.now() + days * 86_400_000);
    const at = async (days: number) => (await serviceStatus(later(days))).find((r) => r.planId === id)!;
    assert.equal((await at(1)).health, 'ok');
    assert.equal((await at(20)).health, 'due');
    assert.match((await at(20)).reason!, /days left/);
    assert.equal((await at(31)).health, 'overdue');
    assert.match((await at(31)).reason!, /days over/);

    const fresh = ok(await as(owner).get(`/vehicles/${ids.v1}`));
    ok(await as(owner).patch(`/vehicles/${ids.v1}`, { version: fresh.version, engineHours: 5600 }));
    assert.equal((await rowOf(id)).reason, '100 engine hours over');
  });

  test('a plan follows a truck type, needs an interval, and takes a type or a truck but not both', async () => {
    const truck = ok(await as(owner).get(`/vehicles/${ids.v1}`));
    assert.equal((await as(owner).post('/service-plans', { code: 'X', name: 'X', vehicleId: ids.v1 })).status, 422);
    assert.equal((await as(owner).post('/service-plans', { code: 'X', name: 'X', everyKm: 100 })).status, 422);
    assert.equal((await plan({ vehicleTypeId: truck.vehicleTypeId })).status, 422);
    const { id } = ok(await as(owner).post('/service-plans', { code: 'X', name: 'X', vehicleTypeId: truck.vehicleTypeId, everyKm: 20_000 }), 201);
    const rows = (await serviceStatus()).filter((r) => r.planId === id);
    assert.ok(rows.some((r) => r.vehicleId === ids.v1));
  });

  test('the reading counts what the truck has driven on its trip, and the trip adds it when it ends', async () => {
    await setOdometer(100_000);
    const { id } = ok(await plan(), 201);
    await rowOf(id);
    const trip = ok(await newTrip(), 201);
    ok(await as(ops).post(`/trips/${trip.id}/dispatch`));
    ok(await as(ops).post(`/trips/${trip.id}/position`, { km: 300, speed: 60, source: 'simulator' }));
    assert.equal((await rowOf(id)).odometerKm, 100_000 + ok(await as(ops).get(`/trips/${trip.id}`)).tracking.km);
    const driven = ok(await as(ops).get(`/trips/${trip.id}`)).tracking.km;
    ok(await as(ops).post(`/trips/${trip.id}/stop`, { reason: 'Truck broke down', closingFuelL: 100 }));
    assert.equal(ok(await as(owner).get(`/vehicles/${ids.v1}`)).odometerKm, 100_000 + driven);
    assert.equal((await rowOf(id)).odometerKm, 100_000 + driven, 'not counted twice');
  });
});

describe('work orders', () => {
  beforeEach(() => setAreas('maintenance', 'parts', 'tyres'));

  test('a truck held by an open work order cannot start a trip, with a clear message; done frees it', async () => {
    const trip = ok(await newTrip(), 201);
    const order = ok(await as(ops).post('/work-orders', { vehicleId: ids.v1, description: 'Brakes' }), 201);
    assert.equal(order.stopsTruck, true, 'the company default');
    assert.match(order.number, /^WO\/\d\d\/\d{4}$/);

    const refused = await as(ops).post(`/trips/${trip.id}/dispatch`);
    assert.equal(refused.status, 409);
    assert.match(refused.body.error.message, new RegExp(`ALC 4821 is waiting for the workshop on work order ${order.number}`));
    assert.deepEqual(ok<any[]>(await as(ops).get('/maintenance/held-trucks')).map((h) => [h.vehicleId, h.number]), [[ids.v1, order.number]]);

    const inShop = ok(await as(ops).patch(`/work-orders/${order.id}`, { version: order.version, stage: 'in_workshop' }));
    assert.ok(inShop.startedAt, 'started when it went in');
    const again = await as(ops).post(`/trips/${trip.id}/dispatch`);
    assert.match(again.body.error.message, /is in the workshop on work order/);

    ok(await as(ops).patch(`/work-orders/${order.id}`, { version: inShop.version, stage: 'done' }));
    ok(await as(ops).post(`/trips/${trip.id}/dispatch`));
  });

  test('stopping the truck is a choice on each order, with a company default', async () => {
    ok(await as(ops).post('/work-orders', { vehicleId: ids.v1, stopsTruck: false }), 201);
    ok(await newTrip(), 201);

    const company = ok(await as(owner).get('/company'));
    ok(await as(owner).put('/company', { version: company.version, maintenance: { workOrderStopsTruck: false } }));
    const second = ok(await as(ops).post('/work-orders', { vehicleId: ids.v1 }), 201);
    assert.equal(second.stopsTruck, false);
    const after = ok(await as(owner).get('/company'));
    assert.equal(after.maintenance.dueSoonKm, 1000, 'saving one setting keeps the rest');
  });

  test('a finished order records its reading, costs its labour and parts, and stays finished', async () => {
    await setOdometer(100_000);
    const workshop = ok(await as(owner).post('/parties', { name: 'Mumbwa Truck Repairs', roles: ['workshop'], countryId: (await find(owner, 'countries', 'ZM')).id }), 201);
    assert.equal((await as(ops).post('/work-orders', { vehicleId: ids.v1, workshopPartyId: ids.zambezi })).status, 422, 'a customer is not a workshop');
    const order = ok(await as(ops).post('/work-orders', {
      vehicleId: ids.v1, workshopPartyId: workshop.id, labour: { amountMinor: 500_00, currencyId: ids.ZMW },
      parts: [{ name: 'Brake pad', quantity: 4, unitCost: { amountMinor: 100_00, currencyId: ids.ZMW } }],
    }), 201);
    const done = ok(await as(ops).patch(`/work-orders/${order.id}`, { version: order.version, stage: 'done', odometerKm: 100_250 }));
    assert.ok(done.endedAt);
    assert.equal(ok(await as(owner).get(`/vehicles/${ids.v1}`)).odometerKm, 100_250, 'the workshop reading moves the truck on');
    assert.equal((await as(ops).patch(`/work-orders/${order.id}`, { version: done.version, stage: 'open' })).status, 422);

    await as(ops).post('/work-orders', { vehicleId: ids.v1, source: 'service' }).expect(422);
    const today = new Date().toISOString().slice(0, 10);
    ok(await as(ops).post('/tyre-records', { vehicleId: ids.v1, position: 'Front left', action: 'replaced', at: today, odometerKm: 100_250, cost: { amountMinor: 2000_00, currencyId: ids.ZMW } }), 201);

    const report = ok(await as(ops).get('/maintenance/costs', { from: today, to: today }));
    assert.equal(report.currency, 'ZMW');
    const line = report.rows.find((r: { vehicleId: string }) => r.vehicleId === ids.v1);
    assert.equal(line.workOrders, 1);
    assert.equal(line.workOrderMinor, 900_00);
    assert.equal(line.tyreMinor, 2000_00);
    assert.equal(line.costMinor, 2900_00);
    assert.equal(line.perKmMinor, null, 'no km in the period yet');
  });

  test('cost per km divides by what the truck drove in the period', async () => {
    await setOdometer(100_000);
    const trip = ok(await newTrip(), 201);
    ok(await as(ops).post(`/trips/${trip.id}/dispatch`));
    ok(await as(ops).post(`/trips/${trip.id}/position`, { km: 300, speed: 60, source: 'simulator' }));
    ok(await as(ops).post(`/trips/${trip.id}/stop`, { reason: 'Truck broke down', closingFuelL: 100 }));
    const driven = ok(await as(ops).get(`/trips/${trip.id}`)).tracking.km;
    const order = ok(await as(ops).post('/work-orders', { vehicleId: ids.v1, labour: { amountMinor: 1000_00, currencyId: ids.ZMW } }), 201);
    ok(await as(ops).patch(`/work-orders/${order.id}`, { version: order.version, stage: 'done' }));
    const today = new Date().toISOString().slice(0, 10);
    const line = ok(await as(ops).get('/maintenance/costs', { from: today, to: today })).rows.find((r: { vehicleId: string }) => r.vehicleId === ids.v1);
    assert.equal(line.km, Math.round(driven));
    assert.equal(line.perKmMinor, Math.round(1000_00 / driven));
  });

  test('a driver reports a defect from the phone: it opens a work order and tells the office, and does not stop the truck by default', async () => {
    ok(await as(owner).put(`/users/driver-access/${ids.d1}`, { phone: '+260971234567', password: 'Truck2026' }));
    const driver = { token: ok<{ accessToken: string }>(await api().post('/api/v1/auth/login').send({ phone: '+260971234567', password: 'Truck2026' })).accessToken };
    const defect = { note: 'The left mirror is cracked' };
    assert.equal((await as(driver).post('/driver-app/defects', defect)).status, 409, 'no truck yet');
    assert.equal(ok(await as(driver).get('/driver-app/home')).canReportDefect, true);

    const trip = ok(await newTrip(), 201);
    const send = () => api().post('/api/v1/driver-app/defects').set(bearer(driver)).set('Idempotency-Key', 'phone-defect-1').send(defect);
    const order = ok(await send(), 201);
    assert.equal(ok(await send(), 201).id, order.id, 'sent twice on a weak signal, recorded once');
    assert.equal(order.source, 'defect');
    assert.equal(order.vehicleId, ids.v1);
    assert.equal(order.description, defect.note);
    assert.equal(order.stopsTruck, false);
    ok(await as(ops).post(`/trips/${trip.id}/dispatch`));

    const inbox = ok<any[]>(await as(ops).get('/messages', { thread: 'queue:work-orders' }));
    assert.ok(inbox.some((m) => m.title === `Defect on ALC 4821 · ${order.number}` && /left mirror/.test(m.text)));

    await setAreas();
    assert.equal(ok(await as(driver).get('/driver-app/home')).canReportDefect, false);
    await as(driver).post('/driver-app/defects', defect).expect(403);
  });

  test('who may do what follows the permissions on work orders', async () => {
    const viewer = await userWithRole(owner, 'viewer', 'Vera Viewer');
    ok(await as(viewer).get('/maintenance/services'));
    await as(viewer).post('/work-orders', { vehicleId: ids.v1 }).expect(403);
    ok(await as(fin).get('/work-orders'));
    await as(fin).post('/work-orders', { vehicleId: ids.v1 }).expect(403);
  });
});
