// V1 scenarios (#102, Lakshya 11 Nov): what a transporter expects in real life, written first. Each test says what
// should happen at the yard, on the road or in the office; the features are built to make them pass, not the
// other way round. A made-up Zambian fuel and copper haulier (the small sample) runs them.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { api, bearer, find, loadSample, resetDatabase, signUp, startDatabase, stopDatabase, userWithRole, type Session } from './helpers.js';

let owner: Session, ops: Session, fin: Session;
const ids: Record<string, string> = {};
type Stop = { id: string; kind: string; placeId: string; arrivedAt?: string; leftAt?: string };
type Leg = { id: string; kind: 'pickup' | 'drop'; placeId?: string; stopId?: string; status: string; actual?: any[]; times?: Record<string, string>; loading?: Record<string, string> };
type Cn = { id: string; number: string; version: number; status: string; customerId: string; lines: Array<{ id: string }>; legs: Leg[]; [k: string]: any };
type Trip = { id: string; number: string; version: number; status?: string; stops: Stop[]; dispatchedAt?: string; endedAt?: string; [k: string]: any };

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
const fuel = (qty: number, extra: Record<string, unknown> = {}) => ({ qty, ambientL: qty, tempC: 20, density: 835, ...extra });
const zmw = (major: number) => ({ amountMinor: Math.round(major * 100), currencyId: ids.ZMW });
const tripNow = async (id: string) => ok<Trip>(await as(ops).get(`/trips/${id}`));
const onTrip = async (id: string) => ok<Cn[]>(await as(ops).get('/consignments', { tripId: id, limit: 100 }));
const account = async (driver: string) => ok<{ balanceMinor: number }>(await as(fin).get(`/driver-accounts/${ids[driver]}`));

/** A Dar run for truck 1 (or 2) with the given consignments, made by the owner and dispatched when asked. */
async function trip(body: Record<string, unknown> = {}, dispatch = true, truck: 1 | 2 = 1): Promise<Trip> {
  const made = ok<Trip>(await as(owner).post('/trips', {
    customerId: ids.zambezi, vehicleId: ids[`v${truck}`], driverId: ids[`d${truck}`], trailerId: ids[`t${truck}`], routeId: ids.routeDar, plannedStart: '2026-11-12T06:00:00.000Z', ...body,
  }), 201);
  return dispatch ? ok<Trip>(await as(ops).post(`/trips/${made.id}/dispatch`)) : made;
}
const pickupOf = (c: Cn) => c.legs.find((l) => l.kind === 'pickup')!;
const dropOf = (c: Cn) => c.legs.find((l) => l.kind === 'drop')!;
const record = async (c: Cn, leg: Leg, body: Record<string, unknown>) => ok(await as(ops).post(`/consignments/${c.id}/legs/${leg.id}/record`, body));
const load = (c: Cn, qty = 38000, extra: Record<string, unknown> = {}) => record(c, pickupOf(c), { measures: [{ lineId: c.lines[0]!.id, ...fuel(qty) }], documents: [{ number: `INV-${c.number}` }], ...extra });
const deliver = (c: Cn, qty = 38000, extra: Record<string, unknown> = {}, measure: Record<string, unknown> = {}) => record(c, dropOf(c), { measures: [{ lineId: c.lines[0]!.id, ...fuel(qty), ...measure }], pod: { number: `POD-${c.number}` }, ...extra });
/** A whole Dar run: dispatched, loaded, through the border, delivered and ended. */
async function runToEnd(truck: 1 | 2 = 1, qty = 38000): Promise<Trip> {
  const t = await trip({ consignments: [{ lines: [{ productId: ids.diesel, plannedQty: qty }] }] }, true, truck);
  const [c] = await onTrip(t.id);
  await load(c!, qty);
  await deliver((await onTrip(t.id))[0]!, qty);
  return ok<Trip>(await as(ops).post(`/trips/${t.id}/end`, { closingFuelL: 120 }));
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
    ['d1', 'drivers', 'Joseph'], ['d2', 'drivers', 'Martha'], ['routeDar', 'routes', 'DAR-LSK'], ['depot', 'places', 'LSK-DEPOT'], ['dar', 'places', 'DAR-PORT'], ['ndola', 'places', 'NDL-YARD'],
    ['diesel', 'products', 'DIESEL-50'], ['ZMW', 'currencies', 'ZMW'], ['USD', 'currencies', 'USD'], ['pmCash', 'payment-methods', 'CASH'], ['ecRoad', 'expense-categories', 'ROAD'],
  ];
  for (const [key, master, search] of lookups) ids[key] = (await find(owner, master, search)).id;
  ok(await as(ops).put(`/vehicle-states/${ids.v1}`, { placeId: ids.depot, fuelL: 600 }));
  ok(await as(ops).put(`/vehicle-states/${ids.v2}`, { placeId: ids.depot, fuelL: 600 }));
});

/* ---------- 1. Planning the next job ---------- */

describe('1. a truck coming back gets its next job planned before it is home', () => {
  test('1.1 the next trip is made while the truck is on the road, starts where this trip ends, and leaves only after it ends', async () => {
    const now = await trip({ consignments: [{ lines: [{ productId: ids.diesel, plannedQty: 38000 }] }] });
    const next = ok<Trip>(await as(ops).post('/trips', { customerId: ids.copper, vehicleId: ids.v1, driverId: ids.d1, trailerId: ids.t1, routeId: ids.routeDar, plannedStart: '2026-11-20T06:00:00.000Z' }), 201);
    assert.equal(next.stops[0]!.placeId, now.stops.at(-1)!.placeId, 'it starts where the trip on the road ends');
    assert.equal(next.startsAfterTripId, now.id);
    refused(await as(ops).post(`/trips/${next.id}/dispatch`), new RegExp(`${now.number}.*(end|finish)`, 'i'));
    const [c] = await onTrip(now.id);
    await load(c!);
    await deliver((await onTrip(now.id))[0]!);
    ok(await as(ops).post(`/trips/${now.id}/end`, { closingFuelL: 150 }));
    ok(await as(ops).post(`/trips/${next.id}/dispatch`));
  });

  test('1.2 only one trip waits behind a truck; a third is refused in words', async () => {
    await trip({});
    ok(await as(ops).post('/trips', { customerId: ids.copper, vehicleId: ids.v1, driverId: ids.d1, trailerId: ids.t1, routeId: ids.routeDar, plannedStart: '2026-11-20T06:00:00.000Z' }), 201);
    refused(await as(ops).post('/trips', { customerId: ids.copper, vehicleId: ids.v1, driverId: ids.d1, trailerId: ids.t1, routeId: ids.routeDar, plannedStart: '2026-11-25T06:00:00.000Z' }), /already has a (next|planned) trip/i);
  });

  test('1.3 a nomination naming a truck still on the road becomes its next trip when the customer accepts', async () => {
    await trip({});
    const n = ok(await as(ops).post('/nominations', { customerId: ids.copper, loadingPlaceId: ids.dar, productId: ids.diesel, qtyPerTruck: 38000, requiredDate: '2026-11-20', trucks: [{ vehicleId: ids.v1, driverId: ids.d1 }] }), 201);
    ok(await as(ops).post(`/nominations/${n.id}/send`));
    ok(await as(ops).post(`/nominations/${n.id}/accept`, {}));
    const converted = ok(await as(ops).post(`/nominations/${n.id}/convert`, { routeId: ids.routeDar }));
    assert.ok(converted, 'converted into a next trip, not refused because the truck is busy');
  });

  test('1.4 the next trip can be funded before the truck is back', async () => {
    await trip({});
    const next = ok<Trip>(await as(ops).post('/trips', { customerId: ids.copper, vehicleId: ids.v1, driverId: ids.d1, trailerId: ids.t1, routeId: ids.routeDar, plannedStart: '2026-11-20T06:00:00.000Z' }), 201);
    const cash = ok(await as(ops).post('/fund-requests', { tripId: next.id, kind: 'cash', amount: zmw(2000) }), 201);
    ok(await as(fin).post(`/fund-requests/${cash.id}/decide`, { approve: true }));
  });
});

/* ---------- 2. Loading ---------- */

describe('2. loading as it happens at a terminal', () => {
  test('2.1 the gate-in, start, finish and gate-out times are kept, and the waiting before loading shows', { todo: 'being built (#102 scenarios)' }, async () => {
    const t = await trip({ consignments: [{ lines: [{ productId: ids.diesel, plannedQty: 38000 }] }] });
    const [c] = await onTrip(t.id);
    await load(c!, 38000, { times: { arrivedAt: '2026-11-12T06:00:00.000Z', startedAt: '2026-11-12T09:30:00.000Z', finishedAt: '2026-11-12T10:15:00.000Z', leftAt: '2026-11-12T10:40:00.000Z' } });
    const after = (await onTrip(t.id))[0]!;
    const leg = pickupOf(after);
    assert.equal(leg.times?.startedAt, '2026-11-12T09:30:00.000Z');
    assert.equal(leg.times?.waitedMinutes, 210 as unknown as string, 'three and a half hours waiting at the gate');
  });

  test('2.2 the loading order number, the bay and the supervisor are kept with the loading', { todo: 'being built (#102 scenarios)' }, async () => {
    const t = await trip({ consignments: [{ lines: [{ productId: ids.diesel, plannedQty: 38000 }] }] });
    const [c] = await onTrip(t.id);
    await load(c!, 38000, { loading: { orderNo: 'LO-77812', bay: 'Bay 4', supervisor: 'J. Banda' } });
    assert.deepEqual(pickupOf((await onTrip(t.id))[0]!).loading, { orderNo: 'LO-77812', bay: 'Bay 4', supervisor: 'J. Banda' });
  });

  test('2.3 the whole tanker recorded against a small consignment is questioned', async () => {
    const t = await trip({ consignments: [{ lines: [{ productId: ids.diesel, plannedQty: 8000 }] }, { lines: [{ productId: ids.diesel, plannedQty: 30000 }] }] });
    const [c] = await onTrip(t.id);
    const res = await load(c!, 38000);
    assert.match(JSON.stringify(res.checks), /booked for 8,000 L/);
  });

  test('2.4 a loading with a temperature or density out of range is refused before it is recorded', async () => {
    const t = await trip({ consignments: [{ lines: [{ productId: ids.diesel, plannedQty: 38000 }] }] });
    const [c] = await onTrip(t.id);
    const res = await as(ops).post(`/consignments/${c!.id}/legs/${pickupOf(c!).id}/record`, { measures: [{ lineId: c!.lines[0]!.id, ...fuel(38000, { density: 60 }) }] });
    assert.equal(res.status >= 400 && res.status < 500, true, 'a density of 60 is a typing mistake');
  });
});

/* ---------- 3. On the road ---------- */

describe('3. on the road', () => {
  test('3.1 with no GPS, the office marks the border and the drop, and the truck goes on', async () => {
    const t = await trip({ consignments: [{ lines: [{ productId: ids.diesel, plannedQty: 38000 }] }] });
    const [c] = await onTrip(t.id);
    await load(c!);
    const border = t.stops.find((s) => s.kind === 'border')!;
    ok(await as(ops).post(`/trips/${t.id}/stops/${border.id}/arrive`));
    const drop = t.stops.find((s) => s.kind === 'offload')!;
    ok(await as(ops).post(`/trips/${t.id}/stops/${drop.id}/arrive`));
    const now = await tripNow(t.id);
    assert.ok(now.stops.find((s) => s.kind === 'border')!.leftAt, 'the border was left on the way to the drop');
  });

  test('3.2 a receipt in US dollars is approved and taken off the driver in kwacha', async () => {
    const t = await trip({ consignments: [{ lines: [{ productId: ids.diesel, plannedQty: 38000 }] }] });
    const before = (await account('d1')).balanceMinor;
    ok(await as(fin).post('/expenses', { driverId: ids.d1, tripId: t.id, categoryId: ids.ecRoad, amount: { amountMinor: 50_00, currencyId: ids.USD }, receiptNo: 'TZ-991' }), 201);
    const after = (await account('d1')).balanceMinor;
    assert.ok(before - after > 50_00, 'converted at the day\'s rate, more kwacha than dollars');
  });

  test('3.3 the relief driver takes over on the road; the trip, messages and the account follow the new driver', { todo: 'being built (#102 scenarios)' }, async () => {
    const t = await trip({ consignments: [{ lines: [{ productId: ids.diesel, plannedQty: 38000 }] }] });
    ok(await as(ops).post(`/trips/${t.id}/driver`, { driverId: ids.d2, reason: 'Joseph taken ill at Nakonde' }));
    assert.equal((await tripNow(t.id)).driverId, ids.d2);
  });

  test('3.4 a consignment added on the road (a backhaul) gets stops after where the truck is', async () => {
    const t = await trip({ consignments: [{ lines: [{ productId: ids.diesel, plannedQty: 38000 }] }] });
    const [c] = await onTrip(t.id);
    await load(c!);
    const border = t.stops.find((s) => s.kind === 'border')!;
    ok(await as(ops).post(`/trips/${t.id}/stops/${border.id}/arrive`));
    const extra = ok<Cn>(await as(owner).post('/consignments', { tripId: t.id, customerId: ids.copper, lines: [{ productId: ids.diesel, plannedQty: 2000 }], legs: [{ kind: 'pickup', placeId: ids.depot }, { kind: 'drop', placeId: ids.ndola }] }), 201);
    const now = await tripNow(t.id);
    const at = (stopId?: string) => now.stops.findIndex((s) => s.id === stopId);
    assert.ok(at(pickupOf(extra).stopId) > at(border.id), 'picked up after the border the truck has passed');
  });
});

/* ---------- 4. At the drop ---------- */

describe('4. at the drop', () => {
  test('4.1 a part refusal: the customer is billed for what it accepted, and the refused litres wait for a decision', { todo: 'being built (#102 scenarios)' }, async () => {
    const t = await trip({ consignments: [{ lines: [{ productId: ids.diesel, plannedQty: 16000 }] }] });
    const [c] = await onTrip(t.id);
    await load(c!, 16000);
    await deliver((await onTrip(t.id))[0]!, 15950, {}, { accepted: 15800 });
    const after = (await onTrip(t.id))[0]!;
    assert.equal(after.refusals?.[0]?.status, 'to_decide');
    assert.equal(after.refusals?.[0]?.qty, 150);
    refused(await as(ops).post(`/trips/${t.id}/end`, { closingFuelL: 100 }), /refused/i);
  });

  test('4.2 the refused litres are brought back to the depot: the trip gets a drop there, and then closes', { todo: 'being built (#102 scenarios)' }, async () => {
    const t = await trip({ consignments: [{ lines: [{ productId: ids.diesel, plannedQty: 16000 }] }] });
    const [c] = await onTrip(t.id);
    await load(c!, 16000);
    await deliver((await onTrip(t.id))[0]!, 15950, {}, { accepted: 15800 });
    const after = (await onTrip(t.id))[0]!;
    ok(await as(ops).post(`/consignments/${after.id}/refusals/${after.refusals[0].id}/decide`, { outcome: 'write_off', note: 'Water in it; poured off at the depot' }));
    ok(await as(ops).post(`/trips/${t.id}/end`, { closingFuelL: 100 }));
  });

  test('4.3 a shortage beyond the allowance goes to Finance, and charging it lands on the driver\'s account', async () => {
    const t = await trip({ consignments: [{ lines: [{ productId: ids.diesel, plannedQty: 38000 }] }] });
    const [c] = await onTrip(t.id);
    await load(c!);
    await deliver((await onTrip(t.id))[0]!, 37700);
    const after = (await onTrip(t.id))[0]!;
    assert.equal(after.shortage?.status, 'pending');
    const before = (await account('d1')).balanceMinor;
    ok(await as(fin).post(`/consignments/${after.id}/shortage-decision`, { charge: true }));
    assert.ok((await account('d1')).balanceMinor > before, 'the driver owes the shortage');
  });

  test('4.4 the proof of delivery comes in a week after the trip ended and is filed on the consignment', async () => {
    const t = await trip({ consignments: [{ lines: [{ productId: ids.diesel, plannedQty: 38000 }] }] });
    const [c] = await onTrip(t.id);
    await load(c!);
    await record((await onTrip(t.id))[0]!, dropOf((await onTrip(t.id))[0]!), { measures: [{ lineId: c!.lines[0]!.id, ...fuel(38000) }] });
    ok(await as(ops).post(`/trips/${t.id}/end`, { closingFuelL: 100 }));
    const done = (await onTrip(t.id))[0]!;
    ok(await as(ops).post(`/consignments/${done.id}/documents`, { legId: dropOf(done).id, number: 'POD-LATE-1', date: '2026-11-19' }), 201);
    const filed = (await onTrip(t.id))[0]!;
    assert.ok(filed.documents.some((d: { number?: string }) => d.number === 'POD-LATE-1'));
  });
});

/* ---------- 5. Settling with the driver ---------- */

describe('5. settling with the driver', () => {
  test('5.1 a settlement adds a trip allowance and takes off a fine, by hand, each with a reason', async () => {
    const t = await runToEnd();
    const before = (await account('d1')).balanceMinor;
    const s = ok(await as(fin).post('/settlements', {
      driverId: ids.d1, tripIds: [t.id], cashMinor: 0,
      lines: [{ kind: 'allowance', label: 'Trip allowance, Dar run', amountMinor: 1500_00, toDriver: true }, { kind: 'fine', label: 'Speeding fine, Mpika', amountMinor: 300_00, toDriver: false, reason: 'Police ticket MP-2231' }],
    }), 201);
    assert.equal(s.closingMinor, before - 1500_00 + 300_00, 'the company owes 1,200 more');
    assert.equal(s.lines.length, 2);
  });

  test('5.2 a driver with an opening balance and no trip can be settled', async () => {
    ok(await as(owner).patch(`/drivers/${ids.d2}`, { openingBalance: { amountMinor: 800_00, currencyId: ids.ZMW }, version: (await find(owner, 'drivers', 'Martha')).version }));
    const s = ok(await as(fin).post('/settlements', { driverId: ids.d2, tripIds: [], cashMinor: 800_00, note: 'Martha returned the cash she held' }), 201);
    assert.equal(s.closingMinor, 0);
  });

  test('5.3 how the money moved is kept: Airtel Money with its reference', async () => {
    const t = await runToEnd();
    const s = ok(await as(fin).post('/settlements', { driverId: ids.d1, tripIds: [t.id], cashMinor: 0, paidVia: { paymentMethodId: ids.pmCash, reference: 'CASH-0912' } }), 201);
    assert.equal(s.paidVia?.reference, 'CASH-0912');
  });

  test('5.4 a settlement posted by mistake is reversed with a reason; its trips can be settled again', async () => {
    const t = await runToEnd();
    const before = (await account('d1')).balanceMinor;
    const s = ok(await as(fin).post('/settlements', { driverId: ids.d1, tripIds: [t.id], cashMinor: Math.max(0, before) }), 201);
    ok(await as(fin).post(`/settlements/${s.id}/reverse`, { reason: 'Wrong driver picked' }));
    assert.equal((await account('d1')).balanceMinor, before);
    assert.equal((await tripNow(t.id)).settlementId ?? null, null);
  });

  test('5.5 a settlement waits for a receipt still to check, and says which', async () => {
    const t = await runToEnd();
    ok(await as(owner).post('/driver-documents', { driverId: ids.d1, tripId: t.id, kind: 'expense', note: 'Toll receipt', reading: { docNo: 'R1', amount: 100, currencyCode: 'ZMW', categoryId: ids.ecRoad } }), 201);
    refused(await as(fin).post('/settlements', { driverId: ids.d1, tripIds: [t.id], cashMinor: 0 }), /receipt/i);
  });

  test('5.6 two trips settled together; part of the cash carries forward', async () => {
    const a = await runToEnd(1);
    ok(await as(ops).put(`/vehicle-states/${ids.v1}`, { placeId: ids.depot, fuelL: 600 }));
    const b = await runToEnd(1);
    const s = ok(await as(fin).post('/settlements', { driverId: ids.d1, tripIds: [a.id, b.id], cashMinor: 0 }), 201);
    assert.equal(s.tripIds.length, 2);
  });
});

/* ---------- 6. Money ---------- */

describe('6. money on a shared truck', () => {
  test('6.1 three customers on one truck: each consignment bills its own customer at its own price', async () => {
    const rate = (minor: number) => ({ basis: 'per_consignment', price: { amountMinor: minor, currencyId: ids.USD } });
    const t = await trip({ consignments: [
      { customerId: ids.zambezi, lines: [{ productId: ids.diesel, plannedQty: 12000 }], rate: rate(900_00) },
      { customerId: ids.copper, lines: [{ productId: ids.diesel, plannedQty: 12000 }], rate: rate(1100_00) },
    ] });
    const profit = ok(await as(owner).get(`/trips/${t.id}/profit`));
    assert.deepEqual(profit.revenue.map((r: { customer?: string }) => r.customer).sort(), ['Copperbelt Minerals plc', 'Zambezi Energy Ltd']);
  });

  test('6.2 costs never show below zero, and the margin never above 100 %', async () => {
    const t = await trip({ consignments: [{ lines: [{ productId: ids.diesel, plannedQty: 38000 }], rate: { basis: 'per_consignment', price: { amountMinor: 1000_00, currencyId: ids.USD } } }] });
    const [c] = await onTrip(t.id);
    await load(c!);
    await deliver((await onTrip(t.id))[0]!, 37700);
    ok(await as(fin).post(`/consignments/${(await onTrip(t.id))[0]!.id}/shortage-decision`, { charge: true }));
    const profit = ok(await as(owner).get(`/trips/${t.id}/profit`));
    assert.ok(profit.costMinor >= 0);
    assert.ok(profit.marginPercent === null || profit.marginPercent <= 100);
    assert.ok(profit.recovered.amountMinor > 0, 'what the driver pays back is its own line');
  });

  test('6.3 Operations plans trips but never sees the price or the profit', async () => {
    const t = await trip({ consignments: [{ lines: [{ productId: ids.diesel, plannedQty: 38000 }], rate: { basis: 'per_consignment', price: { amountMinor: 1000_00, currencyId: ids.USD } } }] });
    const [c] = await onTrip(t.id);
    assert.equal(c!.rate, undefined);
    assert.equal(c!.revenue, undefined);
    assert.equal((await as(ops).get(`/trips/${t.id}/profit`)).status, 403);
  });
});

/* ---------- 7. Changes and cancellations ---------- */

describe('7. plans change', () => {
  test('7.1 the customer cancels one consignment before loading: it leaves the trip and its stop goes if nothing else needs it', async () => {
    const t = await trip({ consignments: [{ lines: [{ productId: ids.diesel, plannedQty: 20000 }] }, { lines: [{ productId: ids.diesel, plannedQty: 10000 }], legs: [{ kind: 'pickup', placeId: ids.dar }, { kind: 'drop', placeId: ids.ndola }] }] }, false);
    const [, second] = await onTrip(t.id);
    ok(await as(ops).post(`/consignments/${second!.id}/cancel`, { reason: 'Customer cancelled the order', version: second!.version }));
    const now = await tripNow(t.id);
    assert.ok(!now.stops.some((s) => s.placeId === ids.ndola && s.kind === 'offload'), 'the Ndola drop is gone');
  });

  test('7.2 a trip cancelled before it leaves frees the truck and cancels its open money requests', async () => {
    const t = await trip({}, false);
    const cash = ok(await as(ops).post('/fund-requests', { tripId: t.id, kind: 'cash', amount: zmw(1000) }), 201);
    ok(await as(ops).post(`/trips/${t.id}/cancel`, { reason: 'Customer postponed' }));
    const req = ok(await as(fin).get(`/fund-requests/${cash.id}`));
    assert.equal(req.status, 'cancelled');
    ok(await as(owner).post('/trips', { customerId: ids.zambezi, vehicleId: ids.v1, driverId: ids.d1, trailerId: ids.t1, routeId: ids.routeDar, plannedStart: '2026-11-13T06:00:00.000Z' }), 201);
  });
});

/* ---------- 8. The old single-load way still works ---------- */

describe('8. a company that never uses several consignments', () => {
  test('8.1 a trip with no consignment rows is loaded and delivered the old way, from the driver\'s papers', async () => {
    const t = await trip({});
    ok(await as(ops).post('/consignments', { tripId: t.id, lines: [{ productId: ids.diesel, plannedQty: 38000 }] }), 201);
    const [c] = await onTrip(t.id);
    await load(c!);
    await deliver((await onTrip(t.id))[0]!);
    ok(await as(ops).post(`/trips/${t.id}/end`, { closingFuelL: 120 }));
  });

  test('8.2 the trip sheet and the driver statement still print', async () => {
    const t = await runToEnd();
    const sheet = await as(ops).get(`/trips/${t.id}/sheet.pdf`);
    assert.equal(sheet.status, 200);
    const s = ok(await as(fin).post('/settlements', { driverId: ids.d1, tripIds: [t.id], cashMinor: 0 }), 201);
    assert.equal((await as(fin).get(`/settlements/${s.id}/statement.pdf`)).status, 200);
  });
});
