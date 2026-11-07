// #121: what a new company runs into that sample data hides.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { api, bearer, resetDatabase, signUp, startDatabase, stopDatabase, userWithRole, type Session } from './helpers.js';

let owner: Session;
const req = (who: Session) => ({
  get: (path: string) => api().get(`/api/v1${path}`).set(bearer(who)),
  post: (path: string, body: unknown = {}) => api().post(`/api/v1${path}`).set(bearer(who)).send(body as object),
  put: (path: string, body: unknown) => api().put(`/api/v1${path}`).set(bearer(who)).send(body as object),
  del: (path: string) => api().delete(`/api/v1${path}`).set(bearer(who)),
});
const as = () => req(owner);
const ok = <T = any>(res: { status: number; body: any }, status = 200): T => {
  assert.equal(res.status, status, JSON.stringify(res.body).slice(0, 500));
  return res.body.data as T;
};
const first = async (master: string) => ok<{ id: string }[]>(await as().get(`/${master}?limit=1`))[0]!.id;

before(startDatabase);
after(stopDatabase);

describe('a new company with one person doing everything', () => {
  let ids: Record<string, string>;
  let currency: { id: string };
  const newTrip = async () => ok<{ id: string; version: number }>(await as().post('/trips', {
    customerId: ids.customer, vehicleId: ids.truck, driverId: ids.driver, plannedStart: '2026-11-08T06:00:00.000Z',
    stops: [{ placeId: ids.depot, kind: 'start' }, { placeId: ids.depot, kind: 'load' }, { placeId: ids.site, kind: 'offload' }, { placeId: ids.depot, kind: 'end' }],
  }), 201);

  before(async () => {
    await resetDatabase();
    owner = await signUp('Ada Mensah');
    const file = { format: 1, purpose: 'real', company: { key: 'volta-freight', legalName: 'Volta Freight Ghana Limited' }, regional: { country: 'GH', baseCurrency: 'GHS', timezone: 'Africa/Accra' }, brand: { files: {} }, owner: { email: owner.email }, staff: [], connections: [], roles: [], selfSignUp: false, data: { sample: 'starter', files: [] }, deploy: { target: 'compose' } };
    await as().post('/setup-kit/apply', { file }).buffer(true).parse((r, done) => { let t = ''; r.setEncoding('utf8'); r.on('data', (c: string) => { t += c; }); r.on('end', () => done(null, t)); }).expect(200);
    ids = {
      depot: ok<{ id: string }>(await as().post('/places', { code: 'ACC', name: 'Accra depot', type: 'depot', location: { lat: 5.6, lng: -0.19 } }), 201).id,
      site: ok<{ id: string }>(await as().post('/places', { code: 'KUM', name: 'Kumasi site', type: 'customer_site', location: { lat: 6.69, lng: -1.62 } }), 201).id,
      customer: ok<{ id: string }>(await as().post('/parties', { name: 'Ashanti Cement', roles: ['customer'] }), 201).id,
      driver: ok<{ id: string }>(await as().post('/drivers', { firstName: 'Kofi', lastName: 'Boateng', phone: '+233241234567' }), 201).id,
    };
    const truck = ok<{ id: string }>(await as().post('/vehicles', { code: 'T1', registrationNumber: 'GR 1234-24', makeId: await first('vehicle-makes'), vehicleTypeId: await first('vehicle-types') }), 201).id;
    ids.truck = truck;
    ok(await as().put(`/vehicle-states/${ids.truck}`, { placeId: ids.depot, fuelL: 300 }));
    currency = ok<{ id: string; code: string }[]>(await as().get('/currencies?limit=100')).find((c) => c.code === 'GHS')!;
  });

  test('the Owner can decide money requests, with nobody in Finance and after somebody joins', async () => {
    const trip = await newTrip();
    ok(await as().post(`/trips/${trip.id}/dispatch`, {}));
    const cash = ok<{ id: string }>(await as().post('/fund-requests', { tripId: trip.id, kind: 'cash', amount: { amountMinor: 50_000, currencyId: currency.id }, reason: 'First advance' }), 201);
    assert.equal(ok<{ status: string }>(await as().post(`/fund-requests/${cash.id}/decide`, { approve: true })).status, 'approved');
    ok(await as().post(`/fund-requests/${cash.id}/issue`, { paymentMethodId: await first('payment-methods'), reference: 'C-1' }));

    // Someone who joins Finance decides as usual; the Owner still may.
    const finance = await userWithRole(owner, 'finance');
    const second = ok<{ id: string }>(await as().post('/fund-requests', { tripId: trip.id, kind: 'cash', amount: { amountMinor: 1_000, currencyId: currency.id }, reason: 'Toll' }), 201);
    assert.equal(ok<{ status: string }>(await req(finance).post(`/fund-requests/${second.id}/decide`, { approve: true })).status, 'approved');
    ok(await req(finance).post(`/fund-requests/${second.id}/issue`, { paymentMethodId: await first('payment-methods'), reference: 'C-2' }));
  });

  test('what a trip uses can\'t be deleted, or archived while the trip is open, and the trip can always finish', async () => {
    const product = await first('products');
    const trip = await as().get(`/trips?limit=1`);
    const open = ok<{ id: string }[]>(trip)[0]!;
    for (const path of [`/drivers/${ids.driver}`, `/parties/${ids.customer}`, `/vehicles/${ids.truck}`, `/places/${ids.site}`, `/currencies/${currency.id}`]) {
      const refused = await as().del(path);
      assert.equal(refused.status, 409, `${path} ${JSON.stringify(refused.body)}`);
      assert.ok(refused.body.error.details.usage.length > 0, 'and says what uses it');
    }
    const usage = ok<{ total: number; usage: { label: string }[] }>(await as().get(`/vehicles/${ids.truck}/usage`));
    assert.ok(usage.usage.some((u) => u.label === 'Trips'), 'the record\'s Usage tab shows trips');
    for (const path of [`/vehicles/${ids.truck}`, `/drivers/${ids.driver}`]) assert.equal((await as().post(`${path}/archive`, { reason: 'Sold' })).status, 409, path);

    const load = ok<{ id: string }>(await as().post('/consignments', { tripId: open.id, productId: product, invoiceNo: 'INV-1', qty: 28 }), 201);
    ok(await as().post(`/consignments/${load.id}/delivery`, { podNo: 'POD-1', qty: 28 }));
    assert.equal((await as().del(`/products/${product}`)).status, 409, 'a product that was carried');
    ok(await as().post(`/trips/${open.id}/end`, { closingFuelL: 100 }));

    // Once the trip is over, a truck can be sold. A driver has to be settled first: their account leaves the desks with them.
    assert.equal((await as().post(`/drivers/${ids.driver}/archive`, { reason: 'Left' })).status, 409, 'trip still to settle');
    ok(await as().post('/settlements', { driverId: ids.driver, tripIds: [open.id], cashMinor: 51_000 }), 201);
    ok(await as().post(`/vehicles/${ids.truck}/archive`, { reason: 'Sold' }));
    ok(await as().post(`/drivers/${ids.driver}/archive`, { reason: 'Left' }));
  });

  test('the base currency can\'t change once money has been recorded', async () => {
    const usd = ok<{ id: string }>(await as().post('/currencies', { code: 'USD', name: 'US dollar', symbol: '$', minorUnits: 2 }), 201);
    const company = ok<{ version: number; baseCurrencyId: string }>(await as().get('/company'));
    const refused = await as().put('/company', { baseCurrencyId: usd.id, version: company.version });
    assert.equal(refused.status, 409, JSON.stringify(refused.body).slice(0, 300));
    assert.match(refused.body.error.message, /base currency/);
    ok(await as().put('/company', { baseCurrencyId: company.baseCurrencyId, version: company.version }));
  });
});

describe('a new company before any money moves', () => {
  test('can still change its base currency', async () => {
    await resetDatabase();
    owner = await signUp('Ada Mensah');
    const first_ = ok<{ id: string }>(await as().post('/currencies', { code: 'GHS', name: 'Cedi', symbol: 'GH₵', minorUnits: 2 }), 201);
    const second = ok<{ id: string }>(await as().post('/currencies', { code: 'USD', name: 'US dollar', symbol: '$', minorUnits: 2 }), 201);
    const company = await as().put('/company', { legalName: 'Volta Freight', baseCurrencyId: first_.id });
    const version = (company.body.data as { version: number }).version;
    ok(await as().put('/company', { baseCurrencyId: second.id, version }));
  });
});
