import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { PassThrough } from 'node:stream';
import { env } from '../src/config/env.js';
import { setFileStore, type FileStore } from '../src/core/storage/index.js';
import { IdempotencyKey } from '../src/core/idempotency/idempotency.model.js';
import { DriverDocument } from '../src/modules/operations/models/cargo.model.js';
import { StoredFile } from '../src/modules/files/file.model.js';
import { api, bearer, find, loadSample, resetDatabase, signUp, startDatabase, stopDatabase, userWithRole, type Session } from './helpers.js';

/**
 * The driver app on a weak signal (#31): the phone queues what fails and sends it again with the same
 * Idempotency-Key, so a photo, message or arrival that reached the API once is never recorded twice.
 */
const stored = new Map<string, Buffer>();
const memoryStore: FileStore = {
  async put(key, body) { stored.set(key, body); },
  async open(key) {
    const body = stored.get(key);
    if (!body) throw new Error('missing');
    const stream = new PassThrough();
    stream.end(body);
    return stream;
  },
  async remove(key) { stored.delete(key); },
};

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('a real loading invoice photo')]);
const PDF = Buffer.from('%PDF-1.7\nA delivery note');

let owner: Session, ops: Session, fin: Session;
const ids: Record<string, string> = {};

const as = (s: { token: string }) => ({
  get: (path: string, query: Record<string, unknown> = {}) => api().get(`/api/v1${path}`).query(query).set(bearer(s)),
  post: (path: string, body: unknown = {}) => api().post(`/api/v1${path}`).set(bearer(s)).send(body as object),
  put: (path: string, body: unknown) => api().put(`/api/v1${path}`).set(bearer(s)).send(body as object),
  delete: (path: string) => api().delete(`/api/v1${path}`).set(bearer(s)),
  keyed: (path: string, key: string, body: unknown = {}) => api().post(`/api/v1${path}`).set(bearer(s)).set('Idempotency-Key', key).send(body as object),
  upload: (body: Buffer, name: string, type = 'application/octet-stream') => api().post('/api/v1/files').set(bearer(s)).set('Content-Type', type).set('X-File-Name', encodeURIComponent(name)).send(body),
});

const ok = <T = any>(res: { status: number; body: any }, status = 200): T => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body.data as T;
};

async function newTrip(driver = 'd1', vehicle = 'v1', trailer = 't1') {
  ok(await as(ops).put(`/vehicle-states/${ids[vehicle]}`, { placeId: ids.depot, fuelL: 200 }));
  const trip = ok(await as(ops).post('/trips', {
    customerId: ids.zambezi, vehicleId: ids[vehicle], driverId: ids[driver], trailerId: ids[trailer], routeId: ids.routeDar,
    plannedStart: '2026-11-03T06:00:00.000Z', productId: ids.diesel,
  }), 201);
  const f = ok(await as(ops).get(`/trips/${trip.id}/funding`));
  const fuel = ok(await as(ops).post('/fund-requests', { tripId: trip.id, kind: 'fuel', litres: f.fuel.suggested }), 201);
  ok(await as(fin).post(`/fund-requests/${fuel.id}/decide`, { approve: true }));
  ok(await as(fin).post(`/fund-requests/${fuel.id}/issue`, { paymentMethodId: ids.pmDepot, reference: 'DP-1' }));
  ok(await as(ops).post(`/trips/${trip.id}/dispatch`));
  return trip as { id: string; stops: Array<{ id: string; kind: string }> };
}

/** The office gives a driver the app; the driver signs in with their phone. */
async function driverSignsIn(driver = 'd1', phone = '+260971234567') {
  ok(await as(owner).put(`/users/driver-access/${ids[driver]}`, { phone, password: 'Truck2026' }));
  const res = await api().post('/api/v1/auth/login').send({ phone, password: 'Truck2026' });
  return { token: ok<{ accessToken: string }>(res).accessToken };
}

before(async () => { await startDatabase(); setFileStore(memoryStore); });
after(stopDatabase);
beforeEach(async () => {
  await resetDatabase();
  stored.clear();
  owner = await signUp('Owner');
  await loadSample(owner);
  ops = await userWithRole(owner, 'operations', 'Olivia Ops');
  fin = await userWithRole(owner, 'finance', 'Felix Finance');
  const lookups: Array<[string, string, string]> = [
    ['zambezi', 'parties', 'Zambezi'], ['v1', 'vehicles', 'ALC 4821'], ['v2', 'vehicles', 'BCA 9034'], ['t1', 'trailers', 'TAC 7821'], ['t2', 'trailers', 'TBL 6206'],
    ['d1', 'drivers', 'Joseph'], ['d2', 'drivers', 'Martha'], ['routeDar', 'routes', 'DAR-LSK'], ['depot', 'places', 'LSK-DEPOT'],
    ['diesel', 'products', 'DIESEL-50'], ['pmDepot', 'payment-methods', 'DEPOT'],
  ];
  for (const [key, master, search] of lookups) ids[key] = (await find(owner, master, search)).id;
});


describe('the same Idempotency-Key twice', () => {
  test('an upload sent twice keeps one file and answers with the same id', async () => {
    const driver = await driverSignsIn();
    const send = () => api().post('/api/v1/files').set(bearer(driver)).set('Idempotency-Key', 'phone-item-0001-file').set('X-File-Name', 'invoice.jpg').set('Content-Type', 'image/jpeg').send(JPEG);
    const first = ok(await send(), 201);
    const again = await send();
    assert.equal(again.status, 201);
    assert.equal(again.headers['idempotent-replayed'], 'true');
    assert.equal(again.body.data.id, first.id);
    assert.equal(await StoredFile.countDocuments(), 1);
    assert.equal(stored.size, 1, 'one copy in file storage');
  });

  test('a photo and a message from the driver app are filed once', async () => {
    const trip = await newTrip();
    const driver = await driverSignsIn();
    const photo = ok(await as(driver).upload(JPEG, 'invoice.jpg', 'image/jpeg'), 201);
    const first = ok(await as(driver).keyed('/driver-app/send', 'phone-item-0002', { kind: 'loading', fileId: photo.id }), 201);
    const again = ok(await as(driver).keyed('/driver-app/send', 'phone-item-0002', { kind: 'loading', fileId: photo.id }), 201);
    assert.equal(again.id, first.id);
    ok(await as(driver).keyed('/driver-app/send', 'phone-item-0003', { kind: 'other', note: 'Tyre burst' }), 201);
    ok(await as(driver).keyed('/driver-app/send', 'phone-item-0003', { kind: 'other', note: 'Tyre burst' }), 201);
    assert.equal(await DriverDocument.countDocuments({ tripId: trip.id, kind: 'loading' }), 1);
    assert.equal(await DriverDocument.countDocuments({ driverId: ids.d1, kind: 'other' }), 1);
    // Without a key, each request is its own (as before).
    ok(await as(driver).post('/driver-app/send', { kind: 'other', note: 'Tyre burst' }), 201);
    assert.equal(await DriverDocument.countDocuments({ driverId: ids.d1, kind: 'other' }), 2);
  });

  test('"I\'ve arrived" sent twice is recorded once; a refusal is not kept, so it can be tried again', async () => {
    const trip = await newTrip();
    const driver = await driverSignsIn();
    const load = trip.stops.find((s) => s.kind === 'load')!;
    ok(await as(driver).keyed(`/driver-app/stops/${load.id}/arrive`, 'phone-item-0004'));
    const again = await as(driver).keyed(`/driver-app/stops/${load.id}/arrive`, 'phone-item-0004');
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.headers['idempotent-replayed'], 'true');
    // A different key for the same stop runs, and the API refuses it: that answer is not stored.
    const offload = trip.stops.find((s) => s.kind === 'offload')!;
    const early = await as(driver).keyed(`/driver-app/stops/${offload.id}/arrive`, 'phone-item-0005');
    assert.ok(early.status >= 400, 'arriving at offloading before loading is refused');
    assert.equal(await IdempotencyKey.countDocuments({ key: 'phone-item-0005' }), 0, 'a refusal frees its key');
  });

  test('keys belong to one person and one route, and a bad key is refused', async () => {
    const driver = await driverSignsIn();
    ok(await as(driver).keyed('/driver-app/send', 'phone-item-0006', { kind: 'other', note: 'Hello' }), 201);
    const elsewhere = await as(driver).keyed('/driver-app/stops/6ae9b82fb4b0ccb3d4455f00/arrive', 'phone-item-0006');
    assert.equal(elsewhere.status, 422, JSON.stringify(elsewhere.body));
    assert.equal((await as(driver).keyed('/driver-app/send', 'bad key!', { kind: 'other', note: 'x' })).status, 422);
    // The same key from another person is theirs alone: it runs.
    const upload = await api().post('/api/v1/files').set(bearer(ops)).set('Idempotency-Key', 'phone-item-0006').set('Content-Type', 'image/jpeg').send(JPEG);
    assert.equal(upload.status, 201, JSON.stringify(upload.body));
    assert.equal(upload.headers['idempotent-replayed'], undefined);
  });

  test('two copies at once: one runs, the other is told to wait', async () => {
    await newTrip();
    const driver = await driverSignsIn();
    const [a, b] = await Promise.all([
      as(driver).keyed('/driver-app/send', 'phone-item-0007', { kind: 'other', note: 'At the border' }),
      as(driver).keyed('/driver-app/send', 'phone-item-0007', { kind: 'other', note: 'At the border' }),
    ]);
    // The second either waits (409, still running) or, if the first already finished, gets its answer (201).
    assert.ok([a.status, b.status].includes(201));
    assert.ok([a.status, b.status].every((s) => s === 201 || s === 409), `${a.status} ${b.status}`);
    assert.equal(await DriverDocument.countDocuments({ driverId: ids.d1, kind: 'other', note: 'At the border' }), 1);
  });
});
