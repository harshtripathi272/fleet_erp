// #121: what clicking through a new company found, from a first money request to an invoice.
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


describe('a new company with no budgets, prices or rates', () => {
  test('no reason asked for without a budget, a shortage is told to Finance, and a rate with no start date bills earlier trips', async () => {
    await resetDatabase();
    owner = await signUp('Ada Mensah');
    const file = { format: 1, purpose: 'real', company: { key: 'volta-freight', legalName: 'Volta Freight Ghana Limited' }, regional: { country: 'GH', baseCurrency: 'GHS', timezone: 'Africa/Accra' }, brand: { files: {} }, owner: { email: owner.email }, staff: [], connections: [], roles: [], selfSignUp: false, data: { sample: 'starter', files: [] }, deploy: { target: 'compose' } };
    await as().post('/setup-kit/apply', { file }).buffer(true).parse((r, done) => { let t = ''; r.setEncoding('utf8'); r.on('data', (c: string) => { t += c; }); r.on('end', () => done(null, t)); }).expect(200);
    const depot = ok<{ id: string }>(await as().post('/places', { code: 'ACC', name: 'Accra depot', type: 'depot', location: { lat: 5.6, lng: -0.19 } }), 201).id;
    const site = ok<{ id: string }>(await as().post('/places', { code: 'KUM', name: 'Kumasi site', type: 'customer_site', location: { lat: 6.69, lng: -1.62 } }), 201).id;
    const customer = ok<{ id: string }>(await as().post('/parties', { name: 'Ashanti Cement', roles: ['customer'] }), 201).id;
    const driver = ok<{ id: string }>(await as().post('/drivers', { firstName: 'Kofi', lastName: 'Boateng', phone: '+233241234567' }), 201).id;
    const truck = ok<{ id: string }>(await as().post('/vehicles', { code: 'T1', registrationNumber: 'GR 1234-24', makeId: await first('vehicle-makes'), vehicleTypeId: await first('vehicle-types') }), 201).id;
    ok(await as().put(`/vehicle-states/${truck}`, { placeId: depot, fuelL: 300 }));
    const stops = [{ placeId: depot, kind: 'start' }, { placeId: depot, kind: 'load' }, { placeId: site, kind: 'offload' }, { placeId: depot, kind: 'end' }];
    const trip = ok<{ id: string }>(await as().post('/trips', { customerId: customer, vehicleId: truck, driverId: driver, stops, plannedStart: '2026-11-08T06:00:00.000Z' }), 201);
    const currency = ok<{ id: string; code: string }[]>(await as().get('/currencies?limit=100')).find((c) => c.code === 'GHS')!;

    const asked = ok<{ id: string; overBudget: boolean }>(await as().post('/fund-requests', { tripId: trip.id, kind: 'cash', amount: { amountMinor: 50_000, currencyId: currency.id } }), 201);
    assert.equal(asked.overBudget, false, 'with no budget there is nothing to be above');

    ok(await as().post(`/fund-requests/${asked.id}/cancel`, {}));
    ok(await as().post(`/trips/${trip.id}/dispatch`, {}));
    const load = ok<{ id: string }>(await as().post('/consignments', { tripId: trip.id, productId: await first('products'), invoiceNo: 'INV-1', qty: 28 }), 201);
    ok(await as().post(`/consignments/${load.id}/delivery`, { podNo: 'POD-1', qty: 27 }));

    const { messages } = ok<{ messages: { thread: string; title?: string; text?: string }[] }>(await as().get('/operations/sync'));
    const toFinance = messages.find((m) => m.thread === 'queue:shortage-decisions' && m.title?.startsWith('Shortage on'));
    assert.ok(toFinance, 'Finance hears about it');
    assert.match(toFinance.text!, /no shortage price/);
    const toDriver = messages.find((m) => m.thread.startsWith('driver:') && m.title === 'Delivery confirmed');
    assert.ok(toDriver, 'the driver is told');
    assert.doesNotMatch(toDriver.text!, /finance will review/, 'nothing is promised that will not happen');

    ok(await as().post(`/trips/${trip.id}/end`, { closingFuelL: 100 }));
    const company = ok<{ modules: string[]; version: number }>(await as().get('/company'));
    ok(await as().put('/company', { modules: [...company.modules, 'billing'], version: company.version }));

    const rate = { code: 'ASH-T', name: 'Ashanti per tonne', customerId: customer, basis: 'per_tonne', price: { amountMinor: 120_00, currencyId: currency.id } };
    const unbilled = async () => ok<{ data: { problem?: string }[] }>(await as().get('/invoices/unbilled-trips')).data[0]!;
    assert.match((await unbilled()).problem!, /No customer rate/);
    const later = ok<{ id: string }>(await as().post('/customer-rates', { ...rate, code: 'LATER', validFrom: '2031-01-01' }), 201);
    assert.match((await unbilled()).problem!, /No customer rate/, 'a rate that starts later still does not cover it');
    assert.ok(later.id);
    ok(await as().post('/customer-rates', rate), 201);
    assert.equal((await unbilled()).problem, undefined, 'one with no start date covers trips already closed');
    const { drafted } = ok<{ drafted: { totalMinor: number }[] }>(await as().post('/invoices/draft', {}));
    assert.equal(drafted[0]!.totalMinor, 27 * 120_00, 'priced on what was delivered');
  });
});
