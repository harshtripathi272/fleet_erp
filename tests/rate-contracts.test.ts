// Rate contracts (#151), from the 11 Nov call with Hanumant and Lakshya's answers on 14 Nov, written first. A big
// customer signs a contract per route and product; Finance enters it; Operations books the consignment and never
// sees the amount, but may charge another rate with a reason (approved by Finance only when the company says so).
// A small customer without a contract gets the day's rate typed while booking.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { api, bearer, find, loadSample, resetDatabase, signUp, startDatabase, stopDatabase, userWithRole, type Session } from './helpers.js';

let owner: Session, ops: Session, fin: Session;
const ids: Record<string, string> = {};
type Leg = { id: string; kind: 'pickup' | 'drop'; placeId?: string };
type Cn = { id: string; number: string; version: number; lines: Array<{ id: string }>; legs: Leg[]; rate?: any; revenue?: any; priceFrom?: any; [k: string]: any };

const as = (s: { token: string }) => ({
  get: (path: string, query: Record<string, unknown> = {}) => api().get(`/api/v1${path}`).query(query).set(bearer(s)),
  post: (path: string, body: unknown = {}) => api().post(`/api/v1${path}`).set(bearer(s)).send(body as object),
  put: (path: string, body: unknown) => api().put(`/api/v1${path}`).set(bearer(s)).send(body as object),
  patch: (path: string, body: unknown) => api().patch(`/api/v1${path}`).set(bearer(s)).send(body as object),
});
const ok = <T = any>(res: { status: number; body: any }, status = 200): T => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body.data as T;
};
const refused = (res: { status: number; body: any }, words: RegExp) => {
  assert.ok(res.status >= 400 && res.status < 500, `expected a refusal, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.match(res.body.error?.message ?? '', words);
};
const zmw = (major: number) => ({ amountMinor: Math.round(major * 100), currencyId: ids.ZMW });
const fuel = (qty: number) => ({ qty, ambientL: qty, tempC: 20, density: 835 });

/** Zambezi's signed contract: diesel Dar → Lusaka at 1.20 a litre on what was delivered. */
async function zambeziContract(line: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return ok(await as(fin).post('/rate-contracts', {
    code: 'ZF-2026-01', name: 'Zambezi fuel 2026', customerId: ids.zambezi, currencyId: ids.ZMW, validFrom: '2026-01-01',
    lines: [{ routeId: ids.routeDar, productId: ids.diesel, basis: 'per_litre', price: zmw(1.2), chargeOn: 'delivered', ...line }], ...extra,
  }), 201);
}

/** Operations books a Dar run for the customer, with what the booking row says about the price. */
async function book(customer: 'zambezi' | 'copper', price: Record<string, unknown> = {}, qty = 38000, truck: 1 | 2 = 1) {
  const res = await as(ops).post('/trips', {
    customerId: ids[customer], vehicleId: ids[`v${truck}`], driverId: ids[`d${truck}`], trailerId: ids[`t${truck}`], routeId: ids.routeDar, plannedStart: '2026-11-15T06:00:00.000Z',
    consignments: [{ lines: [{ productId: ids.diesel, plannedQty: qty }], ...price }],
  });
  return res;
}
const consignmentOf = async (who: Session, tripId: string) => ok<Cn[]>(await as(who).get('/consignments', { tripId, limit: 10 }))[0]!;
const asFinance = async (c: Cn) => ok<Cn>(await as(fin).get(`/consignments/${c.id}`));

async function runIt(tripId: string, loaded = 38000, delivered = loaded) {
  ok(await as(ops).post(`/trips/${tripId}/dispatch`));
  let c = await consignmentOf(ops, tripId);
  ok(await as(ops).post(`/consignments/${c.id}/legs/${c.legs.find((l) => l.kind === 'pickup')!.id}/record`, { measures: [{ lineId: c.lines[0]!.id, ...fuel(loaded) }], documents: [{ number: `INV-${c.number}` }] }));
  c = await consignmentOf(ops, tripId);
  ok(await as(ops).post(`/consignments/${c.id}/legs/${c.legs.find((l) => l.kind === 'drop')!.id}/record`, { measures: [{ lineId: c.lines[0]!.id, ...fuel(delivered) }], pod: { number: `POD-${c.number}` } }));
  return c;
}

before(startDatabase);
after(stopDatabase);
beforeEach(async () => {
  await resetDatabase();
  owner = await signUp('Owner');
  await loadSample(owner);
  ops = await userWithRole(owner, 'operations', 'Olivia Ops');
  fin = await userWithRole(owner, 'finance', 'Felix Finance');
  const lookups: Array<[string, string, string]> = [
    ['zambezi', 'parties', 'Zambezi'], ['copper', 'parties', 'Copperbelt'], ['v1', 'vehicles', 'ALC 4821'], ['v2', 'vehicles', 'BCA 9034'], ['t1', 'trailers', 'TAC 7821'], ['t2', 'trailers', 'TBL 6206'],
    ['d1', 'drivers', 'Joseph'], ['d2', 'drivers', 'Martha'], ['routeDar', 'routes', 'DAR-LSK'], ['depot', 'places', 'LSK-DEPOT'], ['diesel', 'products', 'DIESEL-50'], ['ZMW', 'currencies', 'ZMW'],
  ];
  for (const [key, master, search] of lookups) ids[key] = (await find(owner, master, search)).id;
  ok(await as(ops).put(`/vehicle-states/${ids.v1}`, { placeId: ids.depot, fuelL: 600 }));
  ok(await as(ops).put(`/vehicle-states/${ids.v2}`, { placeId: ids.depot, fuelL: 600 }));
});

describe('rate contracts: Finance enters them, Operations never sees the amounts', () => {
  test('Finance enters a customer\'s contract; Operations may not, and sees it without its prices', async () => {
    refused(await as(ops).post('/rate-contracts', { code: 'X-1', name: 'X', customerId: ids.zambezi, currencyId: ids.ZMW, lines: [{ routeId: ids.routeDar, productId: ids.diesel, basis: 'per_litre', price: zmw(1), chargeOn: 'loaded' }] }), /not allow|cannot/i);
    const contract = await zambeziContract();
    const seen = ok(await as(ops).get(`/rate-contracts/${contract.id}`));
    assert.equal(seen.code, 'ZF-2026-01');
    assert.notEqual(seen.lines[0].price?.amountMinor, 120, 'the price is masked for Operations');
    assert.equal(ok(await as(fin).get(`/rate-contracts/${contract.id}`)).lines[0].price.amountMinor, 120);
  });

  test('a contract lists each route and product once, in its own currency', async () => {
    refused(await as(fin).post('/rate-contracts', {
      code: 'ZF-DUP', name: 'Twice', customerId: ids.zambezi, currencyId: ids.ZMW,
      lines: [{ routeId: ids.routeDar, productId: ids.diesel, basis: 'per_litre', price: zmw(1), chargeOn: 'loaded' }, { routeId: ids.routeDar, productId: ids.diesel, basis: 'per_litre', price: zmw(2), chargeOn: 'loaded' }],
    }), /not valid/i);
  });
});

describe('booking under a contract', () => {
  test('booking Zambezi diesel on the Dar route picks its contract up: Operations sees the contract, not the amount; Finance sees the price', async () => {
    await zambeziContract();
    const answer = ok(await as(ops).get('/rate-contracts/for', { customerId: ids.zambezi, productId: ids.diesel, routeId: ids.routeDar }));
    assert.equal(answer.line.code, 'ZF-2026-01');
    assert.equal(answer.line.price, undefined, 'no amount for Operations');
    const t = ok(await book('zambezi'), 201);
    const c = await consignmentOf(ops, t.id);
    assert.equal(c.priceFrom?.kind, 'contract');
    assert.equal(c.priceFrom?.contractCode, 'ZF-2026-01');
    assert.equal(c.rate, undefined);
    assert.equal(c.revenue, undefined, 'Operations never sees revenue');
    await runIt(t.id, 38000, 37900);
    const priced = await asFinance(c);
    assert.equal(priced.revenue.subtotalMinor, 37900 * 120, 'charged on what was delivered, as the contract says');
    assert.match(priced.revenue.explanation?.join?.(' ') ?? JSON.stringify(priced.revenue), /Rate contract ZF-2026-01/);
  });

  test('a contract charged on the loaded quantity bills the fuel lost on the road too', async () => {
    await zambeziContract({ chargeOn: 'loaded' });
    const t = ok(await book('zambezi'), 201);
    const c = await runIt(t.id, 38000, 37900);
    assert.equal((await asFinance(c)).revenue.subtotalMinor, 38000 * 120);
  });

  test('a fixed amount for the route: a 30,000 L and a 38,000 L truck earn the same', async () => {
    await zambeziContract({ basis: 'per_consignment', price: zmw(45000), chargeOn: 'delivered' });
    const small = ok(await book('zambezi', {}, 30000, 1), 201);
    const big = ok(await book('zambezi', {}, 38000, 2), 201);
    const a = await runIt(small.id, 30000);
    const b = await runIt(big.id, 38000);
    assert.equal((await asFinance(a)).revenue.subtotalMinor, 45000_00);
    assert.equal((await asFinance(b)).revenue.subtotalMinor, 45000_00);
  });

  test('a contract that has ended, or doesn\'t cover the route or goods, is not used: the booking says so', async () => {
    await zambeziContract({}, { validFrom: '2025-01-01', validTo: '2025-12-31' });
    const ended = ok(await as(ops).get('/rate-contracts/for', { customerId: ids.zambezi, productId: ids.diesel, routeId: ids.routeDar }));
    assert.equal(ended.line, null);
    const t = ok(await book('zambezi'), 201);
    assert.notEqual((await consignmentOf(ops, t.id)).priceFrom?.kind, 'contract');
  });
});

describe('another rate than the contract (Lakshya, 14 Nov: the person booking has a say)', () => {
  test('Operations may charge another rate, but must say why', async () => {
    await zambeziContract();
    refused(await book('zambezi', { rate: { basis: 'per_litre', price: zmw(1.1), chargeOn: 'delivered' } }), /ZF-2026-01.*why/i);
    const t = ok(await book('zambezi', { useContract: false, rate: { basis: 'per_litre', price: zmw(1.1), chargeOn: 'delivered' }, rateReason: 'One-off deal agreed by phone' }), 201);
    const c = await consignmentOf(ops, t.id);
    assert.equal(c.priceFrom.kind, 'own');
    assert.equal(c.priceFrom.contractCode, 'ZF-2026-01');
    assert.equal(c.priceFrom.reason, 'One-off deal agreed by phone');
    assert.equal(c.priceFrom.approval, undefined, 'no approval while the company switch is off (the default)');
    assert.equal(c.rate.price.amountMinor, 110, 'Operations sees the rate it typed');
    await runIt(t.id);
    assert.equal((await asFinance(c)).revenue.subtotalMinor, 38000 * 110);
  });

  test('with the company switch on, the other rate waits for Finance and the contract prices it until approved', async () => {
    const company = ok(await as(owner).get('/company'));
    ok(await as(owner).put('/company', { version: company.version, freight: { ownRateNeedsApproval: true } }));
    await zambeziContract();
    const t = ok(await book('zambezi', { useContract: false, rate: { basis: 'per_litre', price: zmw(1.1), chargeOn: 'delivered' }, rateReason: 'Discount for a late booking' }), 201);
    const c = await consignmentOf(ops, t.id);
    assert.equal(c.priceFrom.approval, 'pending');
    const waiting = ok<Cn[]>(await as(fin).get('/consignments', { tab: 'rate_approval' }));
    assert.deepEqual(waiting.map((x) => x.id), [c.id]);
    await runIt(t.id);
    assert.equal((await asFinance(c)).revenue.subtotalMinor, 38000 * 120, 'the contract prices it while it waits');
    refused(await as(ops).post(`/consignments/${c.id}/rate-decision`, { decision: 'approve' }), /not allow/i);
    ok(await as(fin).post(`/consignments/${c.id}/rate-decision`, { decision: 'approve', note: 'Agreed with the owner' }));
    const approved = await asFinance(c);
    assert.equal(approved.priceFrom.approval, 'approved');
    assert.equal(approved.revenue.subtotalMinor, 38000 * 110);
  });

  test('Finance refuses the other rate: the contract prices it and the reason stays on record', async () => {
    const company = ok(await as(owner).get('/company'));
    ok(await as(owner).put('/company', { version: company.version, freight: { ownRateNeedsApproval: true } }));
    await zambeziContract();
    const t = ok(await book('zambezi', { useContract: false, rate: { basis: 'per_litre', price: zmw(0.9), chargeOn: 'delivered' }, rateReason: 'Customer asked' }), 201);
    const c = await consignmentOf(ops, t.id);
    ok(await as(fin).post(`/consignments/${c.id}/rate-decision`, { decision: 'reject', note: 'The contract stands' }));
    const after = await asFinance(c);
    assert.equal(after.priceFrom.kind, 'contract');
    assert.equal(after.priceFrom.approval, 'rejected');
    assert.equal(after.priceFrom.reason, 'Customer asked');
    assert.equal(after.rate, undefined);
  });
});

describe('a small customer with no contract (Q9: Operations types the day\'s rate)', () => {
  test('Operations types the day\'s rate while booking; it prices the consignment', async () => {
    const t = ok(await book('copper', { rate: { basis: 'per_consignment', price: zmw(20000) } }), 201);
    const c = await consignmentOf(ops, t.id);
    assert.equal(c.priceFrom.kind, 'own');
    assert.equal(c.priceFrom.contractCode, undefined);
    assert.equal(c.rate.price.amountMinor, 20000_00);
    await runIt(t.id);
    assert.equal((await asFinance(c)).revenue.subtotalMinor, 20000_00);
  });

  test('a rate Finance typed stays hidden from Operations when Operations edits the goods or the choice', async () => {
    const t = ok(await book('copper'), 201);
    let c = await asFinance(await consignmentOf(ops, t.id));
    c = ok<Cn>(await as(fin).patch(`/consignments/${c.id}`, { version: c.version, rate: { basis: 'per_consignment', price: zmw(33333) } }));
    assert.equal(c.priceFrom.typedBy, 'finance');
    const seen = await consignmentOf(ops, t.id);
    assert.equal(seen.rate, undefined);
    const edited = ok<Cn>(await as(ops).patch(`/consignments/${c.id}`, { version: seen.version, lines: [{ id: seen.lines[0]!.id, productId: ids.diesel, plannedQty: 36000 }] }));
    assert.equal(edited.rate, undefined, 'editing the goods does not reveal the rate');
    const chosen = ok<Cn>(await as(ops).patch(`/consignments/${c.id}`, { version: edited.version, useContract: false }));
    assert.equal(chosen.rate, undefined, 'nor does sending the choice');
    assert.equal((await asFinance(c)).rate.price.amountMinor, 33333_00, 'and the rate is unchanged');
  });

  test('the trip sheet shows Operations no prices', async () => {
    await zambeziContract();
    const t = ok(await book('zambezi'), 201);
    const sheet = ok(await as(ops).get(`/trips/${t.id}/sheet`));
    assert.equal(JSON.stringify(sheet).includes('unitPriceMinor'), false);
    assert.equal(sheet.consignments[0].revenue, undefined);
    assert.ok(ok(await as(fin).get(`/trips/${t.id}/sheet`)).consignments[0].revenue, 'Finance still sees them');
  });

  test('Operations may correct its own rate later, but not see or change one Finance set under a contract', async () => {
    const t = ok(await book('copper', { rate: { basis: 'per_consignment', price: zmw(20000) } }), 201);
    let c = await consignmentOf(ops, t.id);
    c = ok<Cn>(await as(ops).patch(`/consignments/${c.id}`, { version: c.version, rate: { basis: 'per_consignment', price: zmw(21000) } }));
    assert.equal(c.rate.price.amountMinor, 21000_00);
  });
});
