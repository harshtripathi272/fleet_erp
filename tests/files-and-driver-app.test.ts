import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { PassThrough } from 'node:stream';
import { setFileStore, type FileStore } from '../src/core/storage/index.js';
import { api, bearer, find, loadSample, resetDatabase, signUp, startDatabase, stopDatabase, userWithRole, type Session } from './helpers.js';

/**
 * Real documents and the driver app: files uploaded and kept in file storage, documents that say
 * whether they are simulated, and a driver who signs in with their phone and sees only their own work.
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

describe('files', () => {
  test('photos and PDFs are kept in file storage, told apart by their bytes, and fetched only by people allowed to', async () => {
    const photo = ok(await as(ops).upload(JPEG, 'Invoice 4411.jpg', 'image/jpeg'), 201);
    assert.equal(photo.mime, 'image/jpeg');
    assert.equal(photo.name, 'Invoice 4411.jpg');
    assert.equal(stored.size, 1, 'the bytes are in file storage, not the database');
    const pdf = ok(await as(ops).upload(PDF, 'pod.pdf'), 201);
    assert.equal(pdf.mime, 'application/pdf', 'the type comes from the bytes, not what the browser says');

    const svg = await as(ops).upload(Buffer.from('<svg onload="alert(1)"/>'), 'x.svg', 'image/svg+xml');
    assert.equal(svg.status, 422, 'anything a browser would run is refused');
    assert.equal((await as(ops).upload(Buffer.alloc(0), 'empty.jpg', 'image/jpeg')).status, 422);

    const download = await api().get(`/api/v1/files/${photo.id}`).set(bearer(fin)).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c)).on('end', () => cb(null, Buffer.concat(chunks)));
    });
    assert.equal(download.status, 200);
    assert.ok((download.body as Buffer).equals(JPEG));
    assert.equal(download.headers['content-type'], 'image/jpeg');
    assert.equal(download.headers['x-content-type-options'], 'nosniff');

    const viewer = await userWithRole(owner, 'viewer');
    assert.equal((await as(viewer).upload(JPEG, 'a.jpg')).status, 403, 'only people who file documents may upload');
    await api().get(`/api/v1/files/${photo.id}`).expect(401);
  });
});

describe('real and simulated documents', () => {
  test('the office files a real photo: nothing is pre-filled, and the figures are typed from it', async () => {
    const trip = await newTrip();
    const photo = ok(await as(ops).upload(JPEG, 'invoice.jpg'), 201);
    const doc = ok(await as(ops).post('/driver-documents', { driverId: ids.d1, tripId: trip.id, kind: 'loading', file: { fileId: photo.id } }), 201);
    assert.equal(doc.simulated, false);
    assert.equal(doc.file.fileId, photo.id);
    assert.equal(doc.reading, undefined);
    const posted = ok(await as(ops).get('/messages', { thread: 'queue:consignments' })).at(-1);
    assert.match(posted.text, /Type the figures from the photo/);
    assert.ok(!posted.buttons.some((b: { label: string }) => b.label === 'Confirm loading'), 'no figures, so nothing to confirm yet');

    const sample = await as(ops).post('/driver-documents', { driverId: ids.d1, tripId: trip.id, kind: 'loading', file: { name: 'x.jpg', mime: 'image/jpeg', sampleId: 'loading:1:0' } });
    assert.equal(sample.status, 422, 'sample pictures only come from the simulated phone');
    const someoneElses = ok(await as(fin).upload(JPEG, 'other.jpg'), 201);
    assert.equal((await as(ops).post('/driver-documents', { driverId: ids.d1, tripId: trip.id, kind: 'loading', file: { fileId: someoneElses.id } })).status, 201, 'Operations reads every document, so may file any upload');
  });

  test('the simulated phone and the drive simulator say so on everything they create', async () => {
    const trip = await newTrip();
    const doc = ok(await as(ops).post('/whatsapp/simulate', {
      driverId: ids.d1, kind: 'loading', file: { name: 'invoice.jpg', mime: 'image/jpeg', sampleId: 'loading:1:0' },
      reading: { docNo: 'INV-1', productId: ids.diesel, qty: 30000, ambientL: 30000, tempC: 25, density: 835 },
    }), 201);
    assert.equal(doc.simulated, true);
    const posted = ok(await as(ops).get('/messages', { thread: 'queue:consignments' })).at(-1);
    assert.match(posted.title, /^Simulated loading invoice/);
    assert.match(posted.text, /not a real document/);

    assert.equal((await as(ops).post(`/trips/${trip.id}/position`, { km: 50, speed: 60 })).status, 422, 'a position must say where it came from');
    const moved = ok(await as(ops).post(`/trips/${trip.id}/position`, { km: 99999, speed: 60, source: 'simulator' }));
    assert.equal(moved.tracking.source, 'simulator');
    const load = moved.stops.find((s: { kind: string }) => s.kind === 'load');
    assert.equal(load.arrivedVia, 'simulator');
    const feed = ok(await as(ops).get('/activity', { tripId: trip.id }));
    assert.ok(feed.some((a: { text: string }) => /\(simulated\)/.test(a.text)), 'the activity feed marks simulated arrivals');
  });
});

describe('driver app', () => {
  test('a driver signs in with their phone and works only on their own trip', async () => {
    const trip = await newTrip();
    await newTrip('d2', 'v2', 't2');
    const joseph = await driverSignsIn();
    const me = ok(await as(joseph).get('/auth/me'));
    assert.equal(me.user.driverId, ids.d1);

    const home = ok(await as(joseph).get('/driver-app/home'));
    assert.equal(home.trip.id, trip.id);
    assert.equal(home.trip.truck, 'ALC 4821');
    assert.equal(home.trip.issued.length, 1, 'the fuel issued for the trip');
    assert.equal(home.trip.next, undefined, 'nothing to send before reaching the loading point');

    await as(joseph).get('/trips').expect(403);
    await as(joseph).get('/operations/sync').expect(403);
    await as(joseph).get('/fund-requests').expect(403);

    const load = trip.stops.find((s) => s.kind === 'load')!;
    const arrived = ok(await as(joseph).post(`/driver-app/stops/${load.id}/arrive`));
    assert.equal(arrived.stops.find((s: { kind: string }) => s.kind === 'load').arrivedVia, 'driver');
    assert.equal(ok(await as(joseph).get('/driver-app/home')).trip.next, 'loading');

    const photo = ok(await as(joseph).upload(JPEG, 'IMG_2201.jpg', 'image/jpeg'), 201);
    const doc = ok(await as(joseph).post('/driver-app/send', { kind: 'loading', fileId: photo.id }), 201);
    assert.equal(doc.channel, 'app');
    assert.equal(doc.simulated, false);
    assert.equal(doc.tripId, trip.id);
    const after = ok(await as(joseph).get('/driver-app/home'));
    assert.equal(after.trip.next, undefined, 'the invoice is with the office');
    assert.equal(after.trip.documents[0].file.fileId, photo.id);
    const thread = ok(await as(joseph).get('/driver-app/messages'));
    assert.ok(thread.some((m: { from: string; attachment?: { fileId?: string } }) => m.from === 'me' && m.attachment?.fileId === photo.id));
    assert.ok(thread.some((m: { from: string; text: string }) => m.from === 'bot' && /Operations will confirm it/.test(m.text)));

    // Files: their own, and what the office filed for them; nobody else's.
    const officePhoto = ok(await as(ops).upload(PDF, 'pod.pdf'), 201);
    await as(joseph).get(`/files/${officePhoto.id}`).expect(404);
    ok(await as(ops).post('/driver-documents', { driverId: ids.d1, tripId: trip.id, kind: 'other', file: { fileId: officePhoto.id } }), 201);
    await as(joseph).get(`/files/${officePhoto.id}`).expect(200);
    const martha = await driverSignsIn('d2', '+260966112233');
    await as(martha).get(`/files/${photo.id}`).expect(404);
    assert.equal((await as(martha).post('/driver-app/send', { kind: 'loading', fileId: photo.id })).status, 422, 'a driver cannot file someone else\'s upload');
    assert.equal((await as(martha).post(`/driver-app/stops/${load.id}/arrive`)).status, 404, 'nor mark a stop on someone else\'s trip');
  });

  test('the office gives and takes access; staff can\'t use the driver app; the company can switch it off', async () => {
    assert.equal((await as(ops).put(`/users/driver-access/${ids.d1}`, { password: 'Truck2026' })).status, 403, 'only people who manage users');
    assert.equal((await as(owner).put(`/users/driver-access/${ids.d1}`, { phone: '+260971234567' })).status, 409, 'a new access needs a password');
    const joseph = await driverSignsIn();
    assert.equal(ok(await as(owner).get(`/users/driver-access/${ids.d1}`)).access.status, 'active');
    assert.equal((await as(owner).put(`/users/driver-access/${ids.d2}`, { phone: '+260971234567', password: 'Truck2026' })).status, 409, 'one phone signs in to one account');
    await as(ops).get('/driver-app/home').expect(403);

    const company = ok(await as(owner).get('/company'));
    ok(await as(owner).put('/company', { modules: ['masters', 'trips', 'finance', 'tracking'], version: company.version }));
    assert.match((await as(joseph).get('/driver-app/home')).body.error.message, /Driver app module is switched off/);

    ok(await as(owner).delete(`/users/driver-access/${ids.d1}`));
    await as(joseph).get('/auth/me').expect(401);
    const again = await api().post('/api/v1/auth/login').send({ phone: '+260971234567', password: 'Truck2026' });
    assert.equal(again.status, 403, 'a deactivated account cannot sign in');
  });
});
