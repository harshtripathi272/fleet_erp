// #136 phase 1: the fleet-exchange kind, and the position store every tracker reading lands in. A truck is
// found by the platform's id, its tracker's device id, then its plate; repeats change nothing; an older
// reading never replaces a newer one; a tracker on no known truck is parked, not lost.
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { signBody } from '../src/core/connections/index.js';
import { readCanonicalEvents } from '../src/core/connections/providers/fleetExchange.js';
import { Vehicle } from '../src/modules/fleet/models/vehicle.model.js';
import { ExternalRef, PositionHistory, UnmatchedTracker, VehiclePosition } from '../src/modules/fleet-exchange/models.js';
import { eventKey, pollTrackers } from '../src/modules/fleet-exchange/positions.service.js';
import { insideGeofence, insidePolygon } from '../src/modules/fleet-status/geo.js';
import { api, bearer, loadSample, resetDatabase, signUp, startDatabase, stopDatabase, type Session } from './helpers.js';

let owner: Session;
const as = (s: Session) => ({
  get: (path: string) => api().get(`/api/v1${path}`).set(bearer(s)),
  post: (path: string, body?: unknown) => api().post(`/api/v1${path}`).set(bearer(s)).send(body as object),
  patch: (path: string, body: unknown) => api().patch(`/api/v1${path}`).set(bearer(s)).send(body as object),
});
const SECRET = 'hook-secret-for-positions-0123';
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

before(startDatabase);
after(stopDatabase);
beforeEach(async () => {
  await resetDatabase();
  owner = await signUp('Owner');
  process.env.CONNECTION_GPS_SIGNING_SECRET = SECRET;
  process.env.CONNECTION_FX_SIGNING_SECRET = SECRET;
});

const call = (id: string, body: unknown) => {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  return api().post(`/api/v1/hooks/${id}`).set('Content-Type', 'application/json').set({ 'X-Signature-Timestamp': ts, 'X-Signature': signBody(SECRET, ts, raw) }).send(raw);
};
/** Two sample trucks: one with a tracker id on it, one known only by its plate. */
async function trucks() {
  await loadSample(owner);
  const [a, b] = await Vehicle.find({ status: 'active' }).sort({ code: 1 }).limit(2).lean();
  await Vehicle.updateOne({ _id: a!._id }, { $set: { gpsDeviceId: '358480081234567' } });
  return { a: a!, b: b! };
}
async function gpsHook() {
  return (await as(owner).post('/connections', {
    code: 'GPS', name: 'Trackers', kind: 'gps', provider: 'webhook', enabled: true,
    settings: { listPath: 'positions', deviceField: 'imei', timeField: 'ts', idField: 'eventId', plateField: 'plate', speedField: 'speed' },
  }).expect(201)).body.data as { id: string };
}
const at = (minutes: number) => Math.floor(Date.UTC(2026, 10, 10, 9, minutes) / 1000);

describe('the fleet-exchange kind', () => {
  test('is listed with its Simulated partner, and a platform connection names its secrets for itself', async () => {
    const kinds = (await as(owner).get('/connection-kinds').expect(200)).body.data as Array<Record<string, any>>;
    const fx = kinds.find((k) => k.kind === 'fleet-exchange')!;
    assert.equal(fx.label, 'Fleet data exchange');
    assert.equal(fx.via, 'simulated');
    assert.deepEqual(fx.providers.map((p: { key: string }) => p.key), ['simulated', 'marichi-json']);
    assert.equal(fx.providers[0].simulated, true);
    assert.ok(kinds.find((k) => k.kind === 'gps'), 'trackers keep their own kind beside it');

    const c = (await as(owner).post('/connections', { code: 'FX', name: 'Dashboard', kind: 'fleet-exchange', provider: 'marichi-json', settings: { baseUrl: 'https://fleet.example.com' } }).expect(201)).body.data;
    assert.deepEqual(c.secrets, { signingSecret: 'CONNECTION_FX_SIGNING_SECRET', apiToken: 'CONNECTION_FX_API_TOKEN', pullToken: 'CONNECTION_FX_PULL_TOKEN', pullTokenNext: 'CONNECTION_FX_PULL_TOKEN_NEXT' });
    assert.equal(c.webhookSecretEnv, 'CONNECTION_FX_SIGNING_SECRET', 'its calls to us are checked with the same signing secret');
    assert.equal(c.settings.includeDriverPhone, false, "the driver's phone stays off unless switched on");
    assert.equal(JSON.stringify(c).includes(SECRET), false, 'no secret value is stored or shown');

    const bad = await as(owner).post('/connections', { code: 'FX2', name: 'Bad', kind: 'fleet-exchange', provider: 'marichi-json', settings: { baseUrl: 'https://x.example.com', authStyle: 'header' } }).expect(422);
    assert.ok(bad.body.error.details['settings.headerName']);
    await as(owner).post('/connections', { code: 'FX3', name: 'Bad', kind: 'fleet-exchange', provider: 'marichi-json', secrets: { apiToken: 'JWT_SECRET' }, settings: { baseUrl: 'https://x.example.com' } }).expect(422);
  });
});

describe('positions from a tracker webhook', () => {
  test("a reading lands on the truck by its tracker id, else by its plate; the answer says what became of each", async () => {
    const { a, b } = await trucks();
    const hook = await gpsHook();
    const r = await call(hook.id, { positions: [
      { eventId: 'e1', imei: '358480081234567', lat: -12.97, lng: 28.64, ts: at(1), speed: 54 },
      { eventId: 'e2', imei: '999', plate: String(b.registrationNumber).toLowerCase().replace(/\s/g, '-'), lat: -15.4, lng: 28.3, ts: at(1) },
    ] }).expect(200);
    assert.deepEqual([r.body.data.accepted, r.body.data.stored, r.body.data.duplicate, r.body.data.unmatched], [2, 2, 0, 0]);
    const pa = await VehiclePosition.findOne({ vehicleId: a._id }).lean();
    assert.deepEqual([pa!.lat, pa!.lng, pa!.speedKmh, pa!.source, pa!.simulated, pa!.geo.coordinates], [-12.97, 28.64, 54, 'device', false, [28.64, -12.97]]);
    assert.ok(await VehiclePosition.exists({ vehicleId: b._id }), 'the plate is matched however it is written');
  });

  test('a repeated event changes nothing; an older reading goes to history only', async () => {
    const { a } = await trucks();
    const hook = await gpsHook();
    const newer = { eventId: 'n1', imei: '358480081234567', lat: -12.5, lng: 28.5, ts: at(30) };
    await call(hook.id, { positions: [newer] }).expect(200);
    const again = await call(hook.id, { positions: [{ ...newer, lat: 0, lng: 0 }] }).expect(200);
    assert.deepEqual([again.body.data.stored, again.body.data.duplicate], [0, 1], 'the same event id twice counts once');
    const older = await call(hook.id, { positions: [{ eventId: 'o1', imei: '358480081234567', lat: -13, lng: 29, ts: at(10) }] }).expect(200);
    assert.equal(older.body.data.stored, 0);
    const held = await VehiclePosition.findOne({ vehicleId: a._id }).lean();
    assert.deepEqual([held!.lat, held!.at.toISOString()], [-12.5, new Date(at(30) * 1000).toISOString()], 'the newer position stays');
    const history = await PositionHistory.find({ vehicleId: a._id }).sort({ at: 1 }).lean();
    assert.deepEqual(history.map((h) => [h.lat, Boolean(h.late)]), [[-13, true], [-12.5, false]]);
    // Without an id, the same reading sent twice is recognised by what it says.
    const plain = { imei: '358480081234567', lat: -12.4, lng: 28.4, ts: at(40) };
    await call(hook.id, { positions: [plain] }).expect(200);
    assert.equal((await call(hook.id, { positions: [plain] }).expect(200)).body.data.duplicate, 1);
    assert.equal(eventKey('position', { deviceId: 'x', at: new Date(0), lat: 1, lng: 2 }), eventKey('position', { deviceId: 'x', at: new Date(0), lat: 1, lng: 2 }));
  });

  test('a tracker on no known truck is parked with its count; matching it keeps its last reading on that truck and later ones follow', async () => {
    const { b } = await trucks();
    const hook = await gpsHook();
    await call(hook.id, { positions: [{ imei: 'UNKNOWN-1', lat: -10, lng: 30, ts: at(5) }, { imei: 'UNKNOWN-1', lat: -10.1, lng: 30.1, ts: at(6) }] }).expect(200);
    const parked = (await as(owner).get('/fleet-exchange/unmatched').expect(200)).body.data;
    assert.equal(parked.length, 1);
    assert.deepEqual([parked[0].deviceId, parked[0].count, parked[0].last.lat], ['UNKNOWN-1', 2, -10.1], 'its newest reading is kept');

    const matched = (await as(owner).post(`/fleet-exchange/unmatched/${parked[0].id}/match`, { vehicleId: String(b._id) }).expect(200)).body.data;
    assert.equal(matched.position, 'stored');
    assert.ok(await ExternalRef.exists({ entity: 'vehicle', externalId: 'UNKNOWN-1', localId: b._id, source: 'manual' }));
    assert.equal((await as(owner).get('/fleet-exchange/unmatched')).body.data.length, 0);
    assert.equal((await VehiclePosition.findOne({ vehicleId: b._id }).lean())!.lat, -10.1);

    await call(hook.id, { positions: [{ imei: 'UNKNOWN-1', lat: -9, lng: 31, ts: at(20) }] }).expect(200);
    assert.equal((await VehiclePosition.findOne({ vehicleId: b._id }).lean())!.lat, -9, 'the tracker is that truck from now on');
    assert.equal(await UnmatchedTracker.countDocuments(), 0);
  });

  test('with Tracking switched off, positions are not kept and the answer says so', async () => {
    await trucks();
    const hook = await gpsHook();
    const company = (await as(owner).get('/company')).body.data;
    await api().put('/api/v1/company').set(bearer(owner)).send({ version: company.version, modules: company.modules.filter((m: string) => m !== 'tracking') }).expect(200);
    const r = await call(hook.id, { positions: [{ imei: '358480081234567', lat: -12, lng: 28, ts: at(1) }] }).expect(200);
    assert.match(r.body.data.note, /Tracking is switched off/);
    assert.equal(await VehiclePosition.countDocuments(), 0);
  });
});

describe('positions a tracker service is asked for (Traccar)', () => {
  test('one round stores what it answers, by device id', async () => {
    const { a } = await trucks();
    process.env.CONNECTION_TRC_PASSWORD = 'traccar-pass';
    await as(owner).post('/connections', { code: 'TRC', name: 'Traccar', kind: 'gps', provider: 'traccar', enabled: true, settings: { baseUrl: 'https://traccar.example.com', user: 'admin' } }).expect(201);
    globalThis.fetch = (async () => new Response(JSON.stringify([{ id: 77, deviceId: 358480081234567, latitude: -12.8, longitude: 28.2, fixTime: '2026-11-10T09:00:00Z', speed: 10 }]), { status: 200 })) as typeof fetch;
    assert.equal(await pollTrackers(), 1);
    const p = await VehiclePosition.findOne({ vehicleId: a._id }).lean();
    assert.deepEqual([p!.lat, p!.speedKmh, p!.eventId], [-12.8, 19, '77'], 'knots become km/h');
    assert.equal(await pollTrackers(), 0, 'the same Traccar position asked again changes nothing');
  });
});

describe('canonical events from a fleet platform', () => {
  test('positions are stored by plate; geofence events are remembered and the answer says acting on them is not built yet', async () => {
    const { b } = await trucks();
    const fx = (await as(owner).post('/connections', { code: 'FX', name: 'Dashboard', kind: 'fleet-exchange', provider: 'simulated', enabled: true }).expect(201)).body.data;
    const body = { schema: 'marichi.fleet-exchange/1', events: [
      { id: 'evt-1', type: 'position', at: '2026-11-10T09:01:00Z', vehicle: { registration: b.registrationNumber }, lat: -12.97, lng: 28.64, speedKmh: 54, source: 'partner' },
      { id: 'evt-2', type: 'geofence.enter', at: '2026-11-10T09:12:40Z', vehicle: { registration: b.registrationNumber }, place: { code: 'REF-NDL' } },
      { id: 'evt-3', type: 'position', at: 'not a date', vehicle: { registration: b.registrationNumber }, lat: 1, lng: 1 },
    ] };
    const r = await call(fx.id, body).expect(200);
    assert.deepEqual([r.body.data.accepted, r.body.data.stored], [2, 1]);
    assert.match(r.body.data.note, /1 event could not be read/);
    assert.match(r.body.data.note, /not built yet/);
    assert.equal((await VehiclePosition.findOne({ vehicleId: b._id }).lean())!.source, 'partner');
    assert.equal((await call(fx.id, body).expect(200)).body.data.duplicate, 2, 'both events seen before');
  });

  test('the canonical reader skips what it cannot read rather than guessing', () => {
    const { events, rejected } = readCanonicalEvents({ events: [{ type: 'position', at: 1793700000, vehicle: { deviceId: 35 }, lat: 1, lng: 2 }, { type: 'position', at: 1793700000, lat: 1, lng: 2 }, { type: 'teleport', at: 1 }] });
    assert.equal(rejected, 2, 'a position for no vehicle, and an unknown type');
    assert.equal(events[0]!.vehicle!.deviceId, '35');
    assert.equal(events[0]!.at.toISOString(), new Date(1793700000 * 1000).toISOString());
  });
});

describe('place geofences', () => {
  const square = [{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }, { lat: 1, lng: 1 }, { lat: 1, lng: 0 }];
  test('a polygon when the place has one, else the circle of its radius', () => {
    assert.equal(insidePolygon({ lat: 0.5, lng: 0.5 }, square), true);
    assert.equal(insidePolygon({ lat: 1.5, lng: 0.5 }, square), false);
    assert.equal(insideGeofence({ lat: 0.5, lng: 0.99 }, { lat: 0, lng: 0, radiusM: 300, polygon: square }), true, 'the shape wins over the circle');
    assert.equal(insideGeofence({ lat: 0.001, lng: 0.001 }, { lat: 0, lng: 0, radiusM: 300 }), true, 'about 157 m away');
    assert.equal(insideGeofence({ lat: 0.01, lng: 0 }, { lat: 0, lng: 0, radiusM: 300 }), false, 'about 1.1 km away');
  });

  test('a place saves a polygon of three corners or more', async () => {
    await loadSample(owner);
    const place = (await as(owner).get('/places').query({ limit: 1 })).body.data[0];
    const saved = (await as(owner).patch(`/places/${place.id}`, { version: place.version, geofencePolygon: square }).expect(200)).body.data;
    assert.equal(saved.geofencePolygon.length, 4);
    await as(owner).patch(`/places/${place.id}`, { version: saved.version, geofencePolygon: square.slice(0, 2) }).expect(422);
  });
});
