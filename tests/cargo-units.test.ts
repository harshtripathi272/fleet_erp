// #75: cargo in any unit: weighed by weighbridge ticket, counted in its unit, and fuel exactly as it was.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
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

async function onTheRoad() {
  ok(await as(ops).put(`/vehicle-states/${ids.v1}`, { placeId: ids.depot, fuelL: 200 }));
  const trip = ok(await as(ops).post('/trips', { customerId: ids.copper, vehicleId: ids.v1, driverId: ids.d1, routeId: ids.routeDar, plannedStart: '2026-11-03T06:00:00.000Z' }), 201);
  ok(await as(ops).post(`/trips/${trip.id}/dispatch`));
  ok(await as(ops).post(`/trips/${trip.id}/position`, { km: 1961, speed: 0, source: 'simulator' }));
  return trip as { id: string; number: string };
}
const newProduct = async (code: string, unitId: string, extra: Record<string, unknown> = {}) => ok(await as(owner).post('/products', { code, name: code, groupId: ids.minerals, unitId, ...extra }), 201).id as string;
const load = (tripId: string, productId: string, body: Record<string, unknown>) => as(ops).post('/consignments', { tripId, productId, invoiceNo: 'INV-1', ...body });
const reached = (tripId: string) => as(ops).post(`/trips/${tripId}/position`, { km: 100_000, speed: 0, source: 'simulator' });

before(startDatabase);
after(stopDatabase);
beforeEach(async () => {
  await resetDatabase();
  owner = await signUp('Olga Owner');
  await loadSample(owner);
  ops = await userWithRole(owner, 'operations', 'Olivia Ops');
  fin = await userWithRole(owner, 'finance', 'Felix Finance');
  const lookups: Array<[string, string, string]> = [
    ['copper', 'parties', 'Copperbelt'], ['v1', 'vehicles', 'ALC 4821'], ['d1', 'drivers', 'Joseph'], ['routeDar', 'routes', 'DAR-LSK'], ['depot', 'places', 'LSK-DEPOT'],
    ['diesel', 'products', 'DIESEL-50'], ['cathodes', 'products', 'CU-CATH'], ['minerals', 'product-groups', 'MINERALS'], ['ZMW', 'currencies', 'ZMW'],
    ['kg', 'units', 'Kilogram'], ['tonne', 'units', 'Tonne'],
  ];
  for (const [key, master, search] of lookups) ids[key] = (await find(owner, master, search)).id;
  ids.bag = ok(await as(owner).post('/units', { code: 'BAG', name: 'Bag', symbol: 'bags', dimension: 'count', decimals: 0 }), 201).id;
  const company = ok(await as(owner).get('/company'));
  ok(await as(owner).put('/company', { version: company.version, operations: { tripStartsFromTruck: false } }));
});

describe('weighed goods', () => {
  test('a copper trip loads by weighbridge ticket and delivers with a shortage in kg, charged to the driver', async () => {
    const copper = await newProduct('CU-KG', ids.kg!, { shortageAllowancePercent: 0.1, shortagePricePerUnit: { amountMinor: 80_00, currencyId: ids.ZMW } });
    const trip = await onTheRoad();
    const loaded = ok(await load(trip.id, copper, { gross: 42_000, tare: 14_000, ticketNo: 'WB-1' }), 201);
    assert.equal(loaded.load.qty, 28_000, 'the net');
    assert.equal(loaded.load.unit, 'kg');
    assert.deepEqual([loaded.load.gross, loaded.load.tare, loaded.load.ticketNo], [42_000, 14_000, 'WB-1']);

    ok(await reached(trip.id));
    const done = ok(await as(ops).post(`/consignments/${loaded.id}/delivery`, { podNo: 'POD-1', gross: 41_900, tare: 14_000, ticketNo: 'WB-2' }));
    assert.equal(done.delivered.qty, 27_900);
    const s = done.shortage;
    assert.equal(s.unit, 'kg');
    assert.equal(s.lossL, 100);
    assert.equal(s.allowanceL, 28, '0.1 % of 28,000 kg');
    assert.equal(s.netShortL, 72);
    assert.equal(s.status, 'pending');
    assert.equal(s.baseAmountMinor, 72 * 80_00);

    const inbox = ok<any[]>(await as(fin).get('/messages', { thread: 'queue:shortage-decisions', limit: 20 }));
    const asked = inbox.find((m) => m.refId === `${loaded.id}-shortage`);
    assert.equal(asked.title, `Shortage on ${trip.number}`);
    assert.match(asked.text, /72 kg beyond/);
    assert.ok(asked.rows.some(([name, value]: [string, string]) => name === 'Loaded' && value === '28,000 kg'));

    ok(await as(fin).post(`/consignments/${loaded.id}/shortage-decision`, { charge: true }));
    const account = ok(await as(fin).get(`/driver-accounts/${ids.d1}`));
    assert.ok(account.entries.some((e: { kind: string; label: string }) => e.kind === 'shortage' && e.label === `Shortage ${loaded.number} · 72 kg`), JSON.stringify(account.entries.map((e: { label: string }) => e.label)));
    const driver = ok<any[]>(await as(ops).get('/messages', { thread: `driver:${ids.d1}`, limit: 30 }));
    assert.ok(driver.some((m) => m.title === 'Loading confirmed' && /28,000 kg/.test(m.text)));
    assert.ok(driver.some((m) => m.title === 'Delivery confirmed' && /72 kg above the allowance/.test(m.text)));
  });

  test('tonnes keep their decimals; the ticket has to add up', async () => {
    const trip = await onTheRoad();
    assert.match((await load(trip.id, ids.cathodes!, { gross: 40 })).body.error.message, /both the gross and the tare/);
    assert.match((await load(trip.id, ids.cathodes!, { gross: 14, tare: 14 })).body.error.message, /less than the gross/);
    assert.equal((await load(trip.id, ids.cathodes!, {})).status, 422);
    const loaded = ok(await load(trip.id, ids.cathodes!, { gross: 40.255, tare: 14.005, ticketNo: 'WB-3' }), 201);
    assert.equal(loaded.load.qty, 26.25);
    ok(await reached(trip.id));
    const done = ok(await as(ops).post(`/consignments/${loaded.id}/delivery`, { podNo: 'POD-3', qty: 26.2 }));
    assert.equal(done.shortage.unit, 't');
    assert.equal(done.shortage.lossL, 0.05, 'a net typed in works when there is no ticket');
    assert.equal(done.shortage.status, 'none', 'no price set: nothing to charge');
  });
});

describe('counted goods', () => {
  test('bags are counted, and a shortage is in bags', async () => {
    const maize = await newProduct('MAIZE', ids.bag!, { packaging: 'bags', shortageAllowancePercent: 0, shortagePricePerUnit: { amountMinor: 300_00, currencyId: ids.ZMW } });
    const trip = await onTheRoad();
    const loaded = ok(await load(trip.id, maize, { qty: 600 }), 201);
    assert.deepEqual([loaded.load.qty, loaded.load.unit], [600, 'bags']);
    ok(await reached(trip.id));
    const done = ok(await as(ops).post(`/consignments/${loaded.id}/delivery`, { podNo: 'POD-4', qty: 595 }));
    assert.deepEqual([done.shortage.unit, done.shortage.netShortL, done.shortage.baseAmountMinor], ['bags', 5, 5 * 300_00]);
  });
});

describe('fuel', () => {
  test('is unchanged: litres at 20 °C, its checks and its words', async () => {
    const trip = await onTheRoad();
    assert.match((await load(trip.id, ids.diesel!, { qty: 38_000 })).body.error.message, /needs temperature and density/);
    const loaded = ok(await load(trip.id, ids.diesel!, { qty: 38_000, ambientL: 38_000, tempC: 20, density: 835 }), 201);
    assert.equal(loaded.load.unit, 'L');
    assert.equal(loaded.load.gross, undefined);
    ok(await reached(trip.id));
    const delivered20 = Math.round(loaded.load.std20L * 0.995);
    const done = ok(await as(ops).post(`/consignments/${loaded.id}/delivery`, { podNo: 'POD-5', qty: 37_800, ambientL: 37_800, tempC: 20, density: 835, certStd20L: delivered20 }));
    assert.equal(done.shortage.unit, 'L');
    assert.equal(done.shortage.loaded20L, loaded.load.std20L);
    assert.equal(done.shortage.delivered20L, delivered20);
    assert.equal(done.shortage.status, 'pending');
    const inbox = ok<any[]>(await as(fin).get('/messages', { thread: 'queue:shortage-decisions', limit: 20 }));
    assert.equal(inbox.find((m) => m.refId === `${loaded.id}-shortage`).title, `Fuel shortage on ${trip.number}`);
    assert.ok(inbox.find((m) => m.refId === `${loaded.id}-shortage`).rows.some(([name]: [string]) => name === 'Loaded at 20 °C'));
    ok(await as(fin).post(`/consignments/${loaded.id}/shortage-decision`, { charge: true }));
    const account = ok(await as(fin).get(`/driver-accounts/${ids.d1}`));
    assert.ok(account.entries.some((e: { label: string }) => /^Fuel shortage .* L$/.test(e.label)));
  });
});

describe('the company chooses', () => {
  test('a kind of cargo it does not carry is refused; at least one stays on', async () => {
    const trip = await onTheRoad();
    let company = ok(await as(owner).get('/company'));
    assert.deepEqual(company.operations.cargoKinds, ['volume', 'weighed', 'counted'], 'all three by default');
    assert.equal((await as(owner).put('/company', { version: company.version, operations: { cargoKinds: [] } })).status, 422);
    ok(await as(owner).put('/company', { version: company.version, operations: { cargoKinds: ['weighed'] } }));
    const refused = await load(trip.id, ids.diesel!, { qty: 38_000, ambientL: 38_000, tempC: 20, density: 835 });
    assert.equal(refused.status, 422);
    assert.match(refused.body.error.message, /doesn't carry volume-corrected liquids/);
    ok(await load(trip.id, ids.cathodes!, { gross: 40, tare: 14 }), 201);
    company = ok(await as(owner).get('/company'));
    assert.deepEqual(company.operations.cargoKinds, ['weighed']);
  });
});
