// #102: a new real company, with only the usual lists and its own records, runs a first trip through to settlement.
// The sample data hides what a company without it runs into, so this runs without it.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { api, bearer, resetDatabase, signUp, startDatabase, stopDatabase, type Session } from './helpers.js';

let owner: Session;
const as = () => ({
  get: (path: string) => api().get(`/api/v1${path}`).set(bearer(owner)),
  post: (path: string, body: unknown = {}) => api().post(`/api/v1${path}`).set(bearer(owner)).send(body as object),
  put: (path: string, body: unknown) => api().put(`/api/v1${path}`).set(bearer(owner)).send(body as object),
});
const ok = <T = any>(res: { status: number; body: any }, status = 200): T => {
  assert.equal(res.status, status, JSON.stringify(res.body).slice(0, 500));
  return res.body.data as T;
};
const first = async (master: string) => ok<{ id: string }[]>(await as().get(`/${master}?limit=1`))[0]!.id;

before(startDatabase);
after(stopDatabase);

describe('a first trip with no sample data', () => {
  test('from the usual lists and four kinds of record to a settled driver', async () => {
    await resetDatabase();
    owner = await signUp('Ada Mensah');
    const file = { format: 1, purpose: 'real', company: { key: 'volta-freight', legalName: 'Volta Freight Ghana Limited' }, regional: { country: 'GH', baseCurrency: 'GHS', timezone: 'Africa/Accra' }, brand: { files: {} }, owner: { email: owner.email }, staff: [], connections: [], roles: [], selfSignUp: false, data: { sample: 'starter', files: [] }, deploy: { target: 'compose' } };
    await as().post('/setup-kit/apply', { file }).buffer(true).parse((r, done) => { let t = ''; r.setEncoding('utf8'); r.on('data', (c: string) => { t += c; }); r.on('end', () => done(null, t)); }).expect(200);

    const needed = async () => ok<{ missing: string[] }>(await as().get('/meta/readiness')).missing;
    assert.deepEqual((await needed()).sort(), ['Customers', 'Drivers', 'Places', 'Trucks'], 'only what is the company\'s own');

    const depot = ok<{ id: string }>(await as().post('/places', { code: 'ACC', name: 'Accra depot', type: 'depot', location: { lat: 5.6, lng: -0.19 } }), 201).id;
    const site = ok<{ id: string }>(await as().post('/places', { code: 'KUM', name: 'Kumasi site', type: 'customer_site', location: { lat: 6.69, lng: -1.62 } }), 201).id;
    const customer = ok<{ id: string }>(await as().post('/parties', { name: 'Ashanti Cement', roles: ['customer'] }), 201).id;
    const driver = ok<{ id: string }>(await as().post('/drivers', { firstName: 'Kofi', lastName: 'Boateng', phone: '+233241234567' }), 201).id;
    const truck = ok<{ id: string }>(await as().post('/vehicles', { code: 'T1', registrationNumber: 'GR 1234-24', makeId: await first('vehicle-makes'), vehicleTypeId: await first('vehicle-types') }), 201).id;
    assert.deepEqual(await needed(), [], 'ready for a first trip');

    // Two drivers can't share a phone: their messages and sign-in are found by it.
    assert.equal((await as().post('/drivers', { firstName: 'Other', lastName: 'Person', phone: '+233241234567' })).status, 409);

    ok(await as().put(`/vehicle-states/${truck}`, { placeId: depot, fuelL: 300 }));
    const stops = [{ placeId: depot, kind: 'start' }, { placeId: depot, kind: 'load' }, { placeId: site, kind: 'offload' }, { placeId: depot, kind: 'end' }];
    const trip = ok<{ id: string }>(await as().post('/trips', { customerId: customer, vehicleId: truck, driverId: driver, stops, plannedStart: '2026-11-08T06:00:00.000Z' }), 201);
    ok(await as().post(`/trips/${trip.id}/dispatch`, {}));

    const product = await first('products');
    const load = ok<{ id: string }>(await as().post('/consignments', { tripId: trip.id, productId: product, invoiceNo: 'INV-1', qty: 28 }), 201);
    ok(await as().post(`/consignments/${load.id}/delivery`, { podNo: 'POD-1', qty: 28 }));
    ok(await as().post(`/trips/${trip.id}/position`, { km: 100_000, speed: 0, source: 'simulator' }));
    ok(await as().post(`/trips/${trip.id}/end`, { closingFuelL: 100 }));
    const settled = ok<{ id: string }>(await as().post('/settlements', { driverId: driver, tripIds: [trip.id], cashMinor: 0 }), 201);
    assert.ok(settled.id, 'the driver is settled');
  });
});
