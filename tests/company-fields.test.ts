// #67: company fields on operational records, asked at the right step, by the office or the driver.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { settleSends } from '../src/modules/messaging/dispatcher.js';
import { OutboundMessage } from '../src/modules/messaging/models/connection.model.js';
import { MessageTemplate } from '../src/modules/messaging/models/messaging.model.js';
import { tripSheetPdf } from '../src/modules/operations/printouts.js';
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
const field = (entity: string, placement: string, key: string, extra: Record<string, unknown> = {}) => as(owner).post('/field-definitions', { entity, placement, key, label: key, type: 'text', ...extra });
const tripBody = () => ({ customerId: ids.zambezi, vehicleId: ids.v1, driverId: ids.d1, routeId: ids.routeDar, plannedStart: '2026-11-03T06:00:00.000Z', productId: ids.diesel });
const load = { productId: '', invoiceNo: 'INV-1', qty: 38000, ambientL: 38000, tempC: 20, density: 835 };

before(startDatabase);
after(stopDatabase);
beforeEach(async () => {
  await resetDatabase();
  owner = await signUp('Olga Owner');
  await loadSample(owner);
  ops = await userWithRole(owner, 'operations', 'Olivia Ops');
  fin = await userWithRole(owner, 'finance', 'Felix Finance');
  const lookups: Array<[string, string, string]> = [
    ['zambezi', 'parties', 'Zambezi'], ['v1', 'vehicles', 'ALC 4821'], ['d1', 'drivers', 'Joseph'], ['routeDar', 'routes', 'DAR-LSK'], ['depot', 'places', 'LSK-DEPOT'],
    ['diesel', 'products', 'DIESEL-50'], ['ZMW', 'currencies', 'ZMW'], ['pmCash', 'payment-methods', 'CASH'], ['ecRoad', 'expense-categories', 'ROAD'],
  ];
  for (const [key, master, search] of lookups) ids[key] = (await find(owner, master, search)).id;
  load.productId = ids.diesel!;
  ok(await as(ops).put(`/vehicle-states/${ids.v1}`, { placeId: ids.depot, fuelL: 200 }));
  const company = ok(await as(owner).get('/company'));
  ok(await as(owner).put('/company', { version: company.version, operations: { tripStartsFromTruck: false } }));
});

describe('defining a field', () => {
  test('an operational record needs a step of its own; a master has none', async () => {
    assert.equal((await as(owner).post('/field-definitions', { entity: 'trips', key: 'ref', label: 'Ref', type: 'text' })).status, 422);
    assert.equal((await field('trips', 'nowhere', 'ref')).status, 422);
    assert.equal((await field('fund-requests', 'ask', 'ref', { askedOf: 'driver' })).status, 422, 'drivers answer only about their trip and load');
    assert.equal((await as(owner).post('/field-definitions', { entity: 'drivers', key: 'x1', label: 'X', type: 'text', placement: 'create' })).status, 422);
    ok(await field('trips', 'create', 'bookingRef', { required: true }), 201);
    const listed = ok<any[]>(await as(ops).get('/operations/company-fields'));
    assert.deepEqual(listed.map((f) => [f.entity, f.placement, f.key, f.required, f.askedOf]), [['trips', 'create', 'bookingRef', true, 'office']]);
  });
});

describe('each step', () => {
  test('a trip asks its fields as it is created, dispatched and closed', async () => {
    ok(await field('trips', 'create', 'bookingRef', { required: true, pattern: '^BK-' }), 201);
    ok(await field('trips', 'dispatch', 'sealNo', { required: true }), 201);
    ok(await field('trips', 'close', 'rating', { type: 'number', required: true, min: 1, max: 5 }), 201);

    const none = await as(ops).post('/trips', tripBody());
    assert.equal(none.status, 422);
    assert.match(none.body.error.message, /Fill in bookingRef/);
    assert.equal((await as(ops).post('/trips', { ...tripBody(), custom: { bookingRef: 'nope' } })).status, 422, 'its rules apply');
    assert.match((await as(ops).post('/trips', { ...tripBody(), custom: { bookingRef: 'BK-1', sealNo: 'S' } })).body.error.message, /sealNo isn't a field of this step/);
    const trip = ok(await as(ops).post('/trips', { ...tripBody(), custom: { bookingRef: 'BK-1' } }), 201);
    assert.deepEqual(trip.custom, { bookingRef: 'BK-1' });

    assert.match((await as(ops).post(`/trips/${trip.id}/dispatch`, {})).body.error.message, /Fill in sealNo/);
    assert.deepEqual(ok(await as(ops).post(`/trips/${trip.id}/dispatch`, { custom: { sealNo: 'S-9' } })).custom, { bookingRef: 'BK-1', sealNo: 'S-9' });

    ok(await as(ops).post(`/trips/${trip.id}/position`, { km: 1961, speed: 0, source: 'simulator' }));
    const loaded = ok(await as(ops).post('/consignments', { tripId: trip.id, ...load }), 201);
    ok(await as(ops).post(`/trips/${trip.id}/position`, { km: 100_000, speed: 0, source: 'simulator' }));
    ok(await as(ops).post(`/consignments/${loaded.id}/delivery`, { podNo: 'P', qty: 38000, ambientL: 38000, tempC: 20, density: 835, certStd20L: loaded.load.std20L }));
    assert.match((await as(ops).post(`/trips/${trip.id}/end`, { closingFuelL: 100 })).body.error.message, /Fill in rating/);
    assert.equal((await as(ops).post(`/trips/${trip.id}/end`, { closingFuelL: 100, custom: { rating: 9 } })).status, 422);
    assert.equal(ok(await as(ops).post(`/trips/${trip.id}/end`, { closingFuelL: 100, custom: { rating: 4 } })).custom.rating, 4);
  });

  test('a trip made another way is asked before it leaves; a moved load keeps its trip\'s answers', async () => {
    const trip = ok(await as(ops).post('/trips', tripBody()), 201);
    ok(await field('trips', 'create', 'bookingRef', { required: true }), 201);
    assert.match((await as(ops).post(`/trips/${trip.id}/dispatch`, {})).body.error.message, /Fill in bookingRef/, 'added after this trip was made');
    ok(await as(ops).post(`/trips/${trip.id}/dispatch`, { custom: { bookingRef: 'BK-2' } }));
    ok(await as(ops).post(`/trips/${trip.id}/position`, { km: 1961, speed: 0, source: 'simulator' }));
    ok(await as(ops).post('/consignments', { tripId: trip.id, ...load }), 201);

    const v2 = (await find(owner, 'vehicles', 'BCA 9034')).id;
    ok(await as(ops).put(`/vehicle-states/${v2}`, { placeId: ids.depot, fuelL: 200 }));
    const reason = (await find(owner, 'cancellation-reasons', 'CUST-CANCEL')).id;
    const moved = ok(await as(owner).post(`/trips/${trip.id}/undelivered`, { outcome: 'transfer', reasonId: reason, vehicleId: v2, closingFuelL: 50 }));
    assert.deepEqual(moved.custom, { bookingRef: 'BK-2' });
    ok(await as(ops).post(`/trips/${moved.id}/dispatch`, {}));
  });

  test('loads, requests, expenses and settlements ask theirs too', async () => {
    ok(await field('consignments', 'loading', 'sealNo', { required: true }), 201);
    ok(await field('consignments', 'delivery', 'receivedBy', { required: true }), 201);
    ok(await field('fund-requests', 'ask', 'costCentre', { required: true }), 201);
    ok(await field('fund-requests', 'approve', 'approvalRef', { required: true }), 201);
    ok(await field('fund-requests', 'pay', 'payRef', { required: true }), 201);
    ok(await field('expenses', 'submit', 'plate', { required: true }), 201);
    ok(await field('expenses', 'approve', 'glCode', { required: true }), 201);
    ok(await field('settlements', 'post', 'voucher', { required: true }), 201);

    const trip = ok(await as(ops).post('/trips', tripBody()), 201);
    const ask = { tripId: trip.id, kind: 'cash', amount: { amountMinor: 100_00, currencyId: ids.ZMW }, reason: 'Fees' };
    assert.match((await as(ops).post('/fund-requests', ask)).body.error.message, /Fill in costCentre/);
    const request = ok(await as(ops).post('/fund-requests', { ...ask, custom: { costCentre: 'CC1' } }), 201);
    assert.match((await as(fin).post(`/fund-requests/${request.id}/decide`, { approve: true })).body.error.message, /Fill in approvalRef/);
    ok(await as(fin).post(`/fund-requests/${request.id}/decide`, { approve: true, custom: { approvalRef: 'A1' } }));
    assert.match((await as(fin).post(`/fund-requests/${request.id}/issue`, { paymentMethodId: ids.pmCash })).body.error.message, /Fill in payRef/);
    const paid = ok(await as(fin).post(`/fund-requests/${request.id}/issue`, { paymentMethodId: ids.pmCash, custom: { payRef: 'P1' } }));
    assert.deepEqual(paid.custom, { costCentre: 'CC1', approvalRef: 'A1', payRef: 'P1' });

    ok(await as(ops).post(`/trips/${trip.id}/dispatch`, {}));
    ok(await as(ops).post(`/trips/${trip.id}/position`, { km: 1961, speed: 0, source: 'simulator' }));
    assert.match((await as(ops).post('/consignments', { tripId: trip.id, ...load })).body.error.message, /Fill in sealNo/);
    const loaded = ok(await as(ops).post('/consignments', { tripId: trip.id, ...load, custom: { sealNo: 'S' } }), 201);
    ok(await as(ops).post(`/trips/${trip.id}/position`, { km: 100_000, speed: 0, source: 'simulator' }));
    const delivery = { podNo: 'P', qty: 38000, ambientL: 38000, tempC: 20, density: 835, certStd20L: loaded.load.std20L };
    assert.match((await as(ops).post(`/consignments/${loaded.id}/delivery`, delivery)).body.error.message, /Fill in receivedBy/);
    assert.equal(ok(await as(ops).post(`/consignments/${loaded.id}/delivery`, { ...delivery, custom: { receivedBy: 'N' } })).custom.receivedBy, 'N');

    const expense = { driverId: ids.d1, tripId: trip.id, categoryId: ids.ecRoad, amount: { amountMinor: 50_00, currencyId: ids.ZMW }, receiptNo: 'R1' };
    // The owner approves as they record it, so both steps' fields are asked at once.
    assert.match((await as(owner).post('/expenses', { ...expense, custom: { plate: 'X' } })).body.error.message, /Fill in glCode/);
    assert.equal(ok(await as(owner).post('/expenses', { ...expense, custom: { plate: 'X', glCode: 'G' } }), 201).status, 'approved');

    ok(await as(ops).post(`/trips/${trip.id}/end`, { closingFuelL: 100 }));
    const settle = { driverId: ids.d1, tripIds: [trip.id], cashMinor: 0 };
    assert.match((await as(fin).post('/settlements', settle)).body.error.message, /Fill in voucher/);
    assert.equal(ok(await as(fin).post('/settlements', { ...settle, custom: { voucher: 'V1' } }), 201).custom.voucher, 'V1');
  });

  test('a field that is archived no longer holds anything up', async () => {
    const def = ok(await field('trips', 'create', 'bookingRef', { required: true }), 201);
    await as(ops).post('/trips', tripBody()).expect(422);
    ok(await as(owner).post(`/field-definitions/${def.id}/archive`, { reason: 'Not used' }));
    ok(await as(ops).post('/trips', tripBody()), 201);
  });
});

describe('the driver', () => {
  test('answers on the phone, and a required answer holds the office step until it comes', async () => {
    ok(await field('consignments', 'delivery', 'sealIntact', { type: 'boolean', askedOf: 'driver', required: true }), 201);
    ok(await field('trips', 'dispatch', 'licenceChecked', { type: 'boolean', askedOf: 'driver' }), 201);
    ok(await field('trips', 'close', 'officeNote'), 201);
    ok(await as(owner).put(`/users/driver-access/${ids.d1}`, { phone: '+260971234567', password: 'Truck2026' }));
    const driver = { token: ok<{ accessToken: string }>(await api().post('/api/v1/auth/login').send({ phone: '+260971234567', password: 'Truck2026' })).accessToken };

    const trip = ok(await as(ops).post('/trips', tripBody()), 201);
    assert.deepEqual(ok(await as(driver).get('/driver-app/home')).questions.map((q: { key: string }) => q.key), ['licenceChecked'], 'not about a load yet, and not the office\'s');
    ok(await as(ops).post(`/trips/${trip.id}/dispatch`, {}));
    ok(await as(ops).post(`/trips/${trip.id}/position`, { km: 1961, speed: 0, source: 'simulator' }));
    const loaded = ok(await as(ops).post('/consignments', { tripId: trip.id, ...load }), 201);
    assert.deepEqual(ok(await as(driver).get('/driver-app/home')).questions.map((q: { key: string }) => q.key).sort(), ['licenceChecked', 'sealIntact']);

    ok(await as(ops).post(`/trips/${trip.id}/position`, { km: 100_000, speed: 0, source: 'simulator' }));
    const delivery = { podNo: 'P', qty: 38000, ambientL: 38000, tempC: 20, density: 835, certStd20L: loaded.load.std20L };
    assert.match((await as(ops).post(`/consignments/${loaded.id}/delivery`, delivery)).body.error.message, /Waiting for the driver to answer sealIntact/);

    assert.match((await as(driver).post('/driver-app/fields', { values: { officeNote: 'x' } })).body.error.message, /isn't asked of you/);
    assert.equal((await as(driver).post('/driver-app/fields', { values: { sealIntact: 'yes' } })).status, 422);
    const send = () => api().post('/api/v1/driver-app/fields').set(bearer(driver)).set('Idempotency-Key', 'phone-fields-1').send({ values: { sealIntact: true, licenceChecked: true } });
    ok(await send());
    ok(await send());
    assert.deepEqual(ok(await as(driver).get('/driver-app/home')).questions, []);
    assert.equal(ok(await as(ops).get(`/trips/${trip.id}`)).custom.licenceChecked, true);
    assert.equal(ok(await as(ops).post(`/consignments/${loaded.id}/delivery`, delivery)).custom.sealIntact, true);
  });
});

describe('documents and messages', () => {
  test('a field marked to print goes on the trip sheet; every field is a placeholder', async () => {
    ok(await field('trips', 'create', 'bookingRef', { label: 'Booking reference', printOn: ['trip_sheet'] }), 201);
    ok(await field('trips', 'create', 'internalNote', { label: 'Internal note' }), 201);
    const trip = ok(await as(ops).post('/trips', { ...tripBody(), custom: { bookingRef: 'BK-77', internalNote: 'Secret' } }), 201);
    const pdf = await tripSheetPdf(trip.id, () => true);
    assert.ok(pdf.body.length > 0);
    const { printedFields } = await import('../src/modules/operations/placements.js');
    assert.deepEqual(await printedFields('trip_sheet', [['trips', trip]]), [['Booking reference', 'BK-77']]);

    assert.equal((await as(owner).post('/message-templates', { code: 'BAD', name: 'Bad', channel: 'sms', event: 'trip.created', audience: 'owner', body: '{{trip.custom.1x}}' })).status, 422);
    ok(await as(owner).post('/message-templates', { code: 'OK-REF', name: 'With ref', channel: 'email', event: 'trip.dispatched', audience: 'owner', subject: 'Ref', body: 'Booking {{trip.custom.bookingRef}} left.' }), 201);
    const template = await MessageTemplate.findOne({ code: 'OK-REF' }).lean();
    ok(await as(owner).post('/notification-rules', { code: 'R-REF', name: 'Ref', event: 'trip.dispatched', recipients: [{ kind: 'role', roleId: (await find(owner, 'roles', 'operations')).id }], templates: [{ channel: 'email', templateId: String(template!._id) }] }), 201);
    ok(await as(ops).post(`/trips/${trip.id}/dispatch`, {}));
    await settleSends();
    const sent = await OutboundMessage.find({ templateId: template!._id }).lean();
    assert.ok(sent.length > 0);
    assert.match(sent[0]!.body, /Booking BK-77 left\./);
  });
});
