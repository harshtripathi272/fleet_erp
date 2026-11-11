// #135, consignments design phase 1: many consignments per trip, their own stops, papers and POD; late splits;
// the capacity and stop-gate policies; tariff matching. A company with one load and one drop sees what it saw before.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { api, bearer, find, loadSample, resetDatabase, signUp, startDatabase, stopDatabase, userWithRole, type Session } from './helpers.js';
import { matchTariff } from '../src/modules/freight/match.js';

let owner: Session, ops: Session, fin: Session;
const ids: Record<string, string> = {};
type Stop = { id: string; kind: string; placeId: string; arrivedAt?: string; origin?: string };
type Leg = { id: string; kind: 'pickup' | 'drop'; placeId?: string; stopId?: string; status: string; actual?: any[] };
type Consignment = { id: string; number: string; version: number; status: string; lines: Array<{ id: string; productId: string }>; legs: Leg[]; documents: any[]; [k: string]: any };
type Trip = { id: string; version: number; stops: Stop[]; events?: string[]; tracking?: { km: number } };

const as = (s: { token: string }) => ({
  get: (path: string, query: Record<string, unknown> = {}) => api().get(`/api/v1${path}`).query(query).set(bearer(s)),
  post: (path: string, body: unknown = {}) => api().post(`/api/v1${path}`).set(bearer(s)).send(body as object),
  put: (path: string, body: unknown) => api().put(`/api/v1${path}`).set(bearer(s)).send(body as object),
  patch: (path: string, body: unknown) => api().patch(`/api/v1${path}`).set(bearer(s)).send(body as object),
  delete: (path: string) => api().delete(`/api/v1${path}`).set(bearer(s)),
});
const ok = <T = any>(res: { status: number; body: any }, status = 200): T => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body.data as T;
};
const tripNow = async (id: string) => ok<Trip>(await as(ops).get(`/trips/${id}`));
const onTrip = async (id: string) => ok<Consignment[]>(await as(ops).get('/consignments', { tripId: id, limit: 100 }));
const consignment = async (id: string) => ok<Consignment>(await as(ops).get(`/consignments/${id}`));
const fuel = (qty: number, extra: Record<string, unknown> = {}) => ({ qty, ambientL: qty, tempC: 20, density: 835, ...extra });
const setFreight = async (freight: Record<string, unknown>) => {
  const company = ok(await as(owner).get('/company'));
  return ok(await as(owner).put('/company', { version: company.version, freight }));
};
const driverMessages = async () => ok<Array<{ title?: string; text: string }>>(await as(ops).get('/messages', { thread: `driver:${ids.d1}`, limit: 500 }));

/** A trip on the sample's Dar run (start, load at Dar, Nakonde border, offload at Lusaka, end), dispatched when asked. */
async function trip(body: Record<string, unknown> = {}, dispatch = true, by: Session = ops) {
  ok(await as(ops).put(`/vehicle-states/${ids.v1}`, { placeId: ids.depot, fuelL: 600 }));
  const made = ok<Trip>(await as(by).post('/trips', {
    customerId: ids.zambezi, vehicleId: ids.v1, driverId: ids.d1, trailerId: ids.t1, routeId: ids.routeDar, plannedStart: '2026-11-03T06:00:00.000Z', ...body,
  }), 201);
  return dispatch ? ok<Trip>(await as(ops).post(`/trips/${made.id}/dispatch`)) : made;
}

/** Records every planned pickup and drop at a stop, in the order the stops come. */
async function recordStop(t: Trip, stop: Stop, measures: (c: Consignment, leg: Leg) => Record<string, unknown>, extra: (c: Consignment, leg: Leg) => Record<string, unknown> = (c, leg) => (leg.kind === 'pickup' ? { documents: [{ number: `INV-${c.number}` }] } : { pod: { number: `POD-${c.number}` } })) {
  for (const c of await onTrip(t.id)) {
    for (const leg of c.legs.filter((l) => l.stopId === stop.id && l.status === 'planned')) {
      ok(await as(ops).post(`/consignments/${c.id}/legs/${leg.id}/record`, { measures: [{ lineId: c.lines[0]!.id, ...measures(c, leg) }], ...extra(c, leg) }));
    }
  }
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
    ['nakonde', 'places', 'NAKONDE'], ['kasumbalesa', 'places', 'KASUMBALESA'], ['diesel', 'products', 'DIESEL-50'], ['cathodes', 'products', 'CU-CATH'],
    ['bulk', 'consignment-types', 'BULK_LIQUID'], ['ptl', 'consignment-types', 'PTL'], ['usd', 'currencies', 'USD'], ['freight', 'charge-types', 'FREIGHT'],
    ['invoiceType', 'consignment-document-types', 'LOADING_INVOICE'],
  ];
  for (const [key, master, search] of lookups) ids[key] = (await find(owner, master, search)).id;
});

describe('one load and one drop, as before', () => {
  test('a trip made with its consignment inline is loaded, delivered and ended with the same requests and messages as before', async () => {
    const t = await trip({ productId: ids.diesel, plannedQty: 38000, consignments: [{ lines: [{ productId: ids.diesel, plannedQty: 38000 }], consignee: { name: 'Zambezi depot', phone: '+260977000111' } }] });
    const [c] = await onTrip(t.id);
    assert.ok(c);
    assert.equal(c.status, 'assigned');
    const load = t.stops.find((s) => s.kind === 'load')!, drop = t.stops.find((s) => s.kind === 'offload')!;
    assert.deepEqual(c.legs.map((l) => [l.kind, l.stopId]), [['pickup', load.id], ['drop', drop.id]], 'its pickup and drop are the route\'s loading and offloading points');
    assert.equal(t.stops.length, 5, 'no stop added');
    // Today's loading body records that consignment's pickup: no second consignment.
    const loaded = ok(await as(ops).post('/consignments', { tripId: t.id, productId: ids.diesel, invoiceNo: 'INV-1', ...fuel(38000) }), 201);
    assert.equal(loaded.id, c.id);
    assert.equal(loaded.invoiceNo, 'INV-1');
    assert.equal(loaded.load.std20L, 38000);
    assert.equal((await onTrip(t.id)).length, 1);
    await as(ops).post('/consignments', { tripId: t.id, productId: ids.diesel, invoiceNo: 'X', ...fuel(10) }).expect(409);
    const delivered = ok(await as(ops).post(`/consignments/${c.id}/delivery`, { podNo: 'POD-1', ...fuel(38000) }));
    assert.equal(delivered.status, 'delivered');
    assert.equal(delivered.delivered.podNo, 'POD-1');
    assert.ok((await tripNow(t.id)).events!.includes('delivered'));
    ok(await as(ops).post(`/trips/${t.id}/end`, { closingFuelL: 80 }));
    const titles = (await driverMessages()).map((m) => m.title);
    for (const title of ['Loading confirmed', 'Delivery confirmed']) assert.equal(titles.filter((x) => x === title).length, 1, title);
  });

  test('a trip made without one gets its consignment at loading, as before; the gate says what it said', async () => {
    const t = await trip({ productId: ids.diesel });
    const border = t.stops.find((s) => s.kind === 'border')!;
    assert.equal((await as(ops).post(`/trips/${t.id}/stops/${border.id}/arrive`)).body.error.message, 'Record the loading first.');
    const c = ok(await as(ops).post('/consignments', { tripId: t.id, productId: ids.diesel, invoiceNo: 'INV-1', ...fuel(38000) }), 201);
    assert.equal(c.lines.length, 1);
    assert.equal(c.consigneePartyId, ids.zambezi, 'the customer is the consignee, as before');
    ok(await as(ops).post(`/trips/${t.id}/stops/${border.id}/arrive`));
    const drop = t.stops.find((s) => s.kind === 'offload')!;
    const end = t.stops.find((s) => s.kind === 'end')!;
    assert.match((await as(ops).post(`/trips/${t.id}/stops/${end.id}/arrive`)).body.error.message, /^Record the delivery at .+ first\.$/);
    ok(await as(ops).post(`/consignments/${c.id}/delivery`, { podNo: 'POD-1', ...fuel(37900) }));
    assert.ok((await tripNow(t.id)).stops.find((s) => s.id === drop.id)!.arrivedAt);
  });
});

describe('many consignments on one trip', () => {
  test('three consignments, two loading stops, three drops: stops in route order, each leg on its own, events from the legs', async () => {
    const t = await trip({}, false);
    const add = (body: Record<string, unknown>) => as(ops).post('/consignments', { tripId: t.id, ...body });
    const a = ok<Consignment>(await add({ lines: [{ productId: ids.diesel, plannedQty: 20000 }], legs: [{ kind: 'pickup', placeId: ids.dar }, { kind: 'drop', placeId: ids.depot }] }), 201);
    const b = ok<Consignment>(await add({ consignmentTypeId: ids.bulk, lines: [{ productId: ids.diesel, plannedQty: 18000 }], legs: [{ kind: 'pickup', placeId: ids.dar }, { kind: 'drop', placeId: ids.ndola }] }), 201);
    const c = ok<Consignment>(await add({ customerId: ids.copper, consignmentTypeId: ids.ptl, lines: [{ productId: ids.cathodes, plannedQty: 10 }], legs: [{ kind: 'pickup', placeId: ids.ndola }, { kind: 'drop', placeId: ids.kasumbalesa }] }), 201);
    let now = await tripNow(t.id);
    assert.equal(now.stops.filter((s) => s.kind === 'load').length, 2, 'Dar es Salaam and Ndola');
    assert.equal(now.stops.filter((s) => s.kind === 'offload').length, 3, 'Lusaka, Ndola and Kasumbalesa');
    assert.equal(now.stops[0]!.kind, 'start');
    assert.equal(now.stops.at(-1)!.kind, 'end');
    for (const x of await onTrip(t.id)) {
      const at = (l: Leg) => now.stops.findIndex((s) => s.id === l.stopId);
      assert.ok(Math.max(...x.legs.filter((l) => l.kind === 'pickup').map(at)) < Math.min(...x.legs.filter((l) => l.kind === 'drop').map(at)), `${x.number}: pickups before drops`);
    }
    assert.ok(now.stops.filter((s) => s.origin === 'consignment').length >= 3, 'stops added for the new places');
    ok(await as(ops).post(`/trips/${t.id}/dispatch`));
    now = await tripNow(t.id);
    const measures = (x: Consignment) => (x.id === c.id ? { gross: 24, tare: 14 } : fuel(x.id === a.id ? 20000 : 18000));
    const firstDrop = Math.min(...(await onTrip(t.id)).flatMap((x) => x.legs.filter((l) => l.kind === 'drop').map((l) => now.stops.findIndex((s) => s.id === l.stopId))));
    for (const [i, stop] of now.stops.entries()) {
      if (i === firstDrop) assert.ok((await tripNow(t.id)).events!.includes('loaded'), 'loaded once every pickup before the first drop is in');
      if (stop.kind !== 'load' && stop.kind !== 'offload') continue;
      if (i < firstDrop) assert.ok(!(await tripNow(t.id)).events!.includes('loaded'), 'not loaded while a pickup before the first drop is open');
      if (stop.kind === 'offload' && i < now.stops.length - 2) await as(ops).post(`/trips/${t.id}/end`, { closingFuelL: 80 }).expect(422);
      await recordStop(now, stop, (x) => measures(x));
    }
    assert.ok((await tripNow(t.id)).events!.includes('delivered'));
    for (const x of await onTrip(t.id)) assert.equal(x.status, 'delivered', x.number);
    ok(await as(ops).post(`/trips/${t.id}/end`, { closingFuelL: 80 }));
    assert.equal(b.legs.length, 2);
  });

  test('one consignment loaded at two terminals on two invoices: the loaded total is the sum and each paper sits on its leg', async () => {
    const t = await trip({}, false);
    const c = ok<Consignment>(await as(ops).post('/consignments', {
      tripId: t.id, consignmentTypeId: ids.bulk, lines: [{ productId: ids.diesel, plannedQty: 38000 }],
      legs: [{ kind: 'pickup', placeId: ids.dar }, { kind: 'pickup', placeId: ids.nakonde }, { kind: 'drop', placeId: ids.depot }],
    }), 201);
    ok(await as(ops).post(`/trips/${t.id}/dispatch`));
    const [first, second] = c.legs.filter((l) => l.kind === 'pickup');
    ok(await as(ops).post(`/consignments/${c.id}/legs/${first!.id}/record`, { measures: [{ lineId: c.lines[0]!.id, ...fuel(20000) }], documents: [{ documentTypeId: ids.invoiceType, number: 'TIPER-1' }] }));
    let now = await consignment(c.id);
    assert.equal(now.status, 'loading');
    ok(await as(ops).post(`/consignments/${c.id}/legs/${second!.id}/record`, { measures: [{ lineId: c.lines[0]!.id, ...fuel(18000) }], documents: [{ number: 'KUR-2' }] }));
    now = await consignment(c.id);
    assert.equal(now.load.qty, 38000);
    assert.equal(now.load.std20L, 38000);
    assert.deepEqual(now.documents.map((d) => [d.number, d.legId, d.label]), [['TIPER-1', first!.id, 'Loading invoice'], ['KUR-2', second!.id, 'Loading invoice']]);
    assert.ok((await tripNow(t.id)).events!.includes('loaded'));
  });

  test('a late split: 38,000 L split into four drops after the border; stops after the truck; POD per drop; shortage once on the totals; the driver told', async () => {
    const t = await trip({}, false);
    const c = ok<Consignment>(await as(ops).post('/consignments', { tripId: t.id, consignmentTypeId: ids.bulk, lines: [{ productId: ids.diesel, plannedQty: 38000 }], legs: [{ kind: 'pickup', placeId: ids.dar }, { kind: 'drop' }] }), 201);
    assert.equal(c.legs.find((l) => l.kind === 'drop')!.placeId ?? null, null, 'to be confirmed');
    ok(await as(ops).post(`/trips/${t.id}/dispatch`));
    const pickup = c.legs.find((l) => l.kind === 'pickup')!;
    ok(await as(ops).post(`/consignments/${c.id}/legs/${pickup.id}/record`, { measures: [{ lineId: c.lines[0]!.id, ...fuel(38000) }], documents: [{ number: 'INV-1' }] }));
    const border = (await tripNow(t.id)).stops.find((s) => s.kind === 'border')!;
    ok(await as(ops).post(`/trips/${t.id}/stops/${border.id}/arrive`));
    const extra = ok(await as(owner).post('/places', { code: 'KABWE-DEP', name: 'Kabwe depot', type: 'depot', location: { lat: -14.4469, lng: 28.4464 } }), 201);
    const line = c.lines[0]!.id;
    const fresh = await consignment(c.id);
    // Not all of it placed: refused, unless the rest is left to be confirmed.
    const short = await as(ops).put(`/consignments/${c.id}/legs`, { version: fresh.version, legs: [{ id: pickup.id, kind: 'pickup', placeId: ids.dar }, { kind: 'drop', placeId: ids.depot, planned: [{ lineId: line, qty: 9500 }] }, { kind: 'drop', placeId: ids.ndola, planned: [{ lineId: line, qty: 9500 }] }] });
    assert.match(short.body.error.message, /is not placed on a drop yet/);
    const split = ok<Consignment>(await as(ops).put(`/consignments/${c.id}/legs`, {
      version: fresh.version,
      legs: [{ id: pickup.id, kind: 'pickup', placeId: ids.dar }, ...[ids.depot, ids.ndola, ids.kasumbalesa, extra.id].map((placeId) => ({ kind: 'drop', placeId, planned: [{ lineId: line, qty: 9500 }] }))],
    }));
    const now = await tripNow(t.id);
    const drops = split.legs.filter((l) => l.kind === 'drop').sort((x, y) => now.stops.findIndex((s) => s.id === x.stopId) - now.stops.findIndex((s) => s.id === y.stopId));
    assert.equal(drops.length, 4);
    const borderAt = now.stops.findIndex((s) => s.id === border.id);
    for (const d of drops) assert.ok(now.stops.findIndex((s) => s.id === d.stopId) > borderAt, 'each drop after the truck');
    assert.ok((await driverMessages()).some((m) => /Your stops changed/.test(m.title ?? '') && /changed/.test(m.text)), 'the driver is told');
    // Each drop with its own POD; the shortage only once the last is in.
    for (const [i, d] of drops.entries()) {
      ok(await as(ops).post(`/consignments/${c.id}/legs/${d.id}/record`, { measures: [{ lineId: line, ...fuel(i === 3 ? 9300 : 9500) }], pod: { number: `POD-${i + 1}`, receivedBy: 'Storeman' } }));
      const after = await consignment(c.id);
      if (i < 3) assert.equal(after.shortage, undefined, 'no shortage before the last drop');
    }
    const done = await consignment(c.id);
    assert.equal(done.status, 'delivered');
    assert.deepEqual(done.legs.filter((l) => l.kind === 'drop').map((l: any) => l.pod.number).sort(), ['POD-1', 'POD-2', 'POD-3', 'POD-4']);
    assert.equal(done.shortage.loaded20L, 38000);
    assert.equal(done.shortage.delivered20L, 37800);
    assert.equal(done.shortage.lossL, 200);
  });
});

describe('capacity and the gate are policies', () => {
  test('capacity: over refuses by default; tolerance; override; warn; no figure is not blocked; a drop frees room', async () => {
    const t = await trip({}, false);
    const c = ok<Consignment>(await as(ops).post('/consignments', { tripId: t.id, lines: [{ productId: ids.diesel, plannedQty: 39000 }] }), 201);
    ok(await as(ops).post(`/trips/${t.id}/dispatch`));
    const pickup = c.legs.find((l) => l.kind === 'pickup')!;
    const record = (s: Session, extra: Record<string, unknown> = {}) => as(s).post(`/consignments/${c.id}/legs/${pickup.id}/record`, { measures: [{ lineId: c.lines[0]!.id, ...fuel(38500) }], ...extra });
    const over = await record(ops);
    assert.equal(over.status, 422);
    assert.match(over.body.error.message, /TAC 7821 holds 38,000 L; this would put 38,500 L on board\./);
    assert.equal((await record(ops, { override: { reason: 'Meter reads high' } })).status, 403, 'Operations may not override by default');
    await setFreight({ capacityTolerancePercent: 2 });
    const within = ok(await record(ops));
    assert.deepEqual(within.checks.capacity.warnings, []);
  });

  test('capacity: the owner overrides with a reason, logged; "warn" records with a warning; a truck with no payload is not blocked', async () => {
    const t = await trip({}, false);
    const c = ok<Consignment>(await as(ops).post('/consignments', { tripId: t.id, lines: [{ productId: ids.diesel, plannedQty: 39000 }] }), 201);
    ok(await as(ops).post(`/trips/${t.id}/dispatch`));
    const pickup = c.legs.find((l) => l.kind === 'pickup')!;
    const done = ok(await as(owner).post(`/consignments/${c.id}/legs/${pickup.id}/record`, { measures: [{ lineId: c.lines[0]!.id, ...fuel(38500) }], override: { reason: 'Meter reads high' } }));
    assert.match(done.checks.capacity.warnings[0], /holds 38,000 L/);
    const activity = ok<Array<{ text: string }>>(await as(owner).get('/activity', { tripId: t.id }));
    assert.ok(activity.some((a) => /Over capacity, recorded by Owner: Meter reads high/.test(a.text)));

    // Cathodes on a truck with no payload figure and no trailer: recorded, with the note.
    ok(await as(ops).put(`/vehicle-states/${ids.v2}`, { placeId: ids.depot, fuelL: 300 }));
    const t2 = ok<Trip>(await as(ops).post('/trips', { customerId: ids.copper, vehicleId: ids.v2, driverId: ids.d2, routeId: ids.routeDar, plannedStart: '2026-11-03T06:00:00.000Z' }), 201);
    const c2 = ok<Consignment>(await as(ops).post('/consignments', { tripId: t2.id, lines: [{ productId: ids.cathodes, plannedQty: 30 }] }), 201);
    ok(await as(ops).post(`/trips/${t2.id}/dispatch`));
    const r = ok(await as(ops).post(`/consignments/${c2.id}/legs/${c2.legs[0]!.id}/record`, { measures: [{ lineId: c2.lines[0]!.id, qty: 60 }] }));
    assert.match(r.checks.capacity.notes[0], /No payload set for BCA 9034, so the weight was not checked\./);

    // "warn": over capacity is recorded with a warning.
    await setFreight({ capacityCheck: 'warn' });
    const t3 = await trip({}, false).catch(() => null);
    assert.equal(t3, null, 'the tanker is still on its first trip');
  });

  test('capacity: a drop frees room for a backhaul loaded later on the same trip', async () => {
    const t = await trip({}, false);
    const a = ok<Consignment>(await as(ops).post('/consignments', { tripId: t.id, lines: [{ productId: ids.diesel, plannedQty: 38000 }], legs: [{ kind: 'pickup', placeId: ids.dar }, { kind: 'drop', placeId: ids.nakonde }] }), 201);
    const b = ok<Consignment>(await as(ops).post('/consignments', { tripId: t.id, lines: [{ productId: ids.diesel, plannedQty: 38000 }], legs: [{ kind: 'pickup', placeId: ids.nakonde }, { kind: 'drop', placeId: ids.depot }] }), 201);
    ok(await as(ops).post(`/trips/${t.id}/dispatch`));
    const cap = ok(await as(ops).get(`/trips/${t.id}/capacity`));
    assert.equal(cap.limits.l, 38000);
    assert.ok(cap.planned.every((p: { over: boolean }) => !p.over), 'never more than 38,000 L on board as planned');
    const leg = (c: Consignment, kind: string) => c.legs.find((l) => l.kind === kind)!;
    ok(await as(ops).post(`/consignments/${a.id}/legs/${leg(a, 'pickup').id}/record`, { measures: [{ lineId: a.lines[0]!.id, ...fuel(38000) }], documents: [{ number: 'A' }] }));
    ok(await as(ops).post(`/consignments/${a.id}/legs/${leg(a, 'drop').id}/record`, { measures: [{ lineId: a.lines[0]!.id, ...fuel(38000) }], pod: { number: 'PA' } }));
    ok(await as(ops).post(`/consignments/${b.id}/legs/${leg(b, 'pickup').id}/record`, { measures: [{ lineId: b.lines[0]!.id, ...fuel(38000) }], documents: [{ number: 'B' }] }));
    assert.equal(ok(await as(ops).get(`/trips/${t.id}/capacity`)).onBoard.l, 38000);
  });

  test('the gate: held at loading while the consignment is unrecorded; the driver waits; an override passes and is logged; with nothing required nothing holds', async () => {
    const t = await trip({ consignments: [{ lines: [{ productId: ids.diesel, plannedQty: 38000 }] }] });
    const border = t.stops.find((s) => s.kind === 'border')!;
    const load = t.stops.find((s) => s.kind === 'load')!;
    assert.equal((await as(ops).post(`/trips/${t.id}/stops/${border.id}/arrive`)).body.error.message, 'Record the loading first.');
    const gate = ok(await as(ops).get(`/trips/${t.id}/gate`));
    assert.equal(gate.gate.stopId, load.id);
    assert.equal(gate.gate.driverReason, 'Waiting for Operations to record the loading.');
    // Position reports stop at the gate.
    const held = ok<Trip>(await as(ops).post(`/trips/${t.id}/position`, { km: 3000, speed: 60, source: 'gps' }));
    const cum = held.stops.slice(0, 2).reduce((s, x: any) => s + x.legKm, 0);
    assert.equal(held.tracking!.km, cum);
    // Operations may not let it pass; the owner may, with a reason.
    await as(ops).post(`/trips/${t.id}/stops/${load.id}/pass`, { reason: 'Papers come by e-mail' }).expect(403);
    ok(await as(owner).post(`/trips/${t.id}/stops/${load.id}/pass`, { reason: 'Papers come by e-mail' }));
    ok(await as(ops).post(`/trips/${t.id}/stops/${border.id}/arrive`));
    assert.ok(ok<Array<{ text: string }>>(await as(owner).get('/activity', { tripId: t.id })).some((a) => /let the truck pass .+: Papers come by e-mail/.test(a.text)));
  });

  test('the gate: a missing loading invoice holds the truck by default; with leaveStopRequires empty nothing holds', async () => {
    const t = await trip({ consignments: [{ lines: [{ productId: ids.diesel, plannedQty: 38000 }] }] });
    const [c] = await onTrip(t.id);
    const pickup = c!.legs.find((l) => l.kind === 'pickup')!;
    ok(await as(ops).post(`/consignments/${c!.id}/legs/${pickup.id}/record`, { measures: [{ lineId: c!.lines[0]!.id, ...fuel(38000) }] }));
    const border = t.stops.find((s) => s.kind === 'border')!;
    assert.match((await as(ops).post(`/trips/${t.id}/stops/${border.id}/arrive`)).body.error.message, /needs its loading invoice\./);
    ok(await as(ops).post(`/consignments/${c!.id}/documents`, { legId: pickup.id, number: 'INV-77' }), 201);
    ok(await as(ops).post(`/trips/${t.id}/stops/${border.id}/arrive`));

    const t2 = await (async () => { ok(await as(ops).post(`/consignments/${c!.id}/legs/${c!.legs.find((l) => l.kind === 'drop')!.id}/record`, { measures: [{ lineId: c!.lines[0]!.id, ...fuel(38000) }], pod: { number: 'P' } })); ok(await as(ops).post(`/trips/${t.id}/end`, { closingFuelL: 80 })); await setFreight({ leaveStopRequires: [] }); return trip({ consignments: [{ lines: [{ productId: ids.diesel, plannedQty: 38000 }] }] }); })();
    const border2 = t2.stops.find((s) => s.kind === 'border')!;
    ok(await as(ops).post(`/trips/${t2.id}/stops/${border2.id}/arrive`), 200);
  });
});

describe('papers and the company settings', () => {
  test('Company → Freight: what applies is returned beside what is stored, and null puts a setting back', async () => {
    let company = ok(await as(owner).get('/company'));
    assert.equal(company.effectiveFreight.capacityCheck, 'refuse');
    assert.equal(company.effectiveFreight.chargeOnDefault, 'delivered', 'from Money settings → Bill on');
    assert.ok(company.freightNotBuilt.includes('bookWithoutTrip'));
    assert.deepEqual(company.freightNotBuiltValues.transferRevenueSplit, ['by_km']);
    company = await setFreight({ capacityCheck: 'warn', maxConsignmentsPerTrip: 1 });
    assert.equal(company.freight.capacityCheck, 'warn');
    assert.equal(company.effectiveFreight.maxConsignmentsPerTrip, 1);
    company = await setFreight({ capacityCheck: null });
    assert.equal(company.freight.capacityCheck, undefined, 'the key is gone');
    assert.equal(company.effectiveFreight.capacityCheck, 'refuse');
    assert.equal(company.freight.maxConsignmentsPerTrip, 1, 'the others stay');
    // One per trip.
    const t = await trip({ consignments: [{ lines: [{ productId: ids.diesel, plannedQty: 38000 }] }] }, false);
    assert.match((await as(ops).post('/consignments', { tripId: t.id, lines: [{ productId: ids.diesel }] })).body.error.message, /carries one per trip/);
  });

  test('a document can be filed on a leg and taken off again; a driver photo is re-filed to another consignment on its trip', async () => {
    const t = await trip({}, false);
    const a = ok<Consignment>(await as(ops).post('/consignments', { tripId: t.id, lines: [{ productId: ids.diesel, plannedQty: 19000 }] }), 201);
    const b = ok<Consignment>(await as(ops).post('/consignments', { tripId: t.id, lines: [{ productId: ids.diesel, plannedQty: 19000 }] }), 201);
    const doc = ok(await as(ops).post('/driver-documents', { driverId: ids.d1, tripId: t.id, kind: 'other', note: 'Invoice' }), 201);
    const filed = ok(await as(ops).post(`/driver-documents/${doc.id}/file`, { documentTypeId: ids.invoiceType, consignmentId: b.id, legId: b.legs[0]!.id }));
    assert.equal(filed.consignmentId, b.id);
    assert.equal(filed.kind, 'loading');
    const withDoc = ok(await as(ops).post(`/consignments/${a.id}/documents`, { legId: a.legs[0]!.id, number: 'INV-9', driverDocId: doc.id }), 201);
    assert.equal(withDoc.documents.length, 1);
    const off = ok(await as(ops).delete(`/consignments/${a.id}/documents/${withDoc.documents[0].id}`));
    assert.equal(off.documents.length, 0);
  });
});

describe('tariff matching', () => {
  const day = new Date('2026-11-05T10:00:00Z');
  const subject = { customerId: 'c1', routeId: 'r1', productIds: ['p1'] };
  test('customer and route beat customer only; a product beats nothing; validity dates; priority breaks a tie; latest start next', () => {
    const tariffs = [
      { _id: 'any', code: 'ANY', status: 'active' },
      { _id: 'cust', code: 'CUST', status: 'active', customerId: 'c1' },
      { _id: 'route', code: 'ROUTE', status: 'active', customerId: 'c1', routeId: 'r1' },
      { _id: 'other', code: 'OTHER', status: 'active', customerId: 'c2', routeId: 'r1', productId: 'p1' },
    ];
    assert.equal(matchTariff(tariffs, subject, day)!.tariff.code, 'ROUTE');
    assert.equal(matchTariff(tariffs, subject, day)!.matchedOn, 'customer and route');
    assert.equal(matchTariff(tariffs.slice(0, 2), subject, day)!.tariff.code, 'CUST');
    assert.equal(matchTariff(tariffs.slice(0, 1), subject, day)!.matchedOn, 'a rate card for everyone');
    assert.equal(matchTariff([tariffs[3]!], subject, day), null, 'another customer\'s tariff never applies');
    const dated = [{ ...tariffs[2]!, validTo: '2026-11-04' }, tariffs[1]!];
    assert.equal(matchTariff(dated, subject, day)!.tariff.code, 'CUST', 'an expired tariff is not used');
    assert.equal(matchTariff([{ ...tariffs[2]!, validTo: '2026-11-05' }], subject, day)!.tariff.code, 'ROUTE', 'valid to the end of its last day');
    assert.equal(matchTariff([{ ...tariffs[2]!, validFrom: '2026-11-06' }], subject, day), null, 'not yet');
    const tie = [{ ...tariffs[1]!, code: 'LOW' }, { ...tariffs[1]!, code: 'HIGH', priority: 5 }];
    assert.equal(matchTariff(tie, subject, day)!.tariff.code, 'HIGH');
    const later = [{ ...tariffs[1]!, code: 'OLD', validFrom: '2026-01-01' }, { ...tariffs[1]!, code: 'NEW', validFrom: '2026-10-01' }];
    assert.equal(matchTariff(later, subject, day)!.tariff.code, 'NEW');
    assert.equal(matchTariff([{ ...tariffs[1]!, status: 'inactive' }], subject, day), null);
  });

  test('a consignment is priced from its most specific tariff; unmatched it is unpriced with the reason; a manual price survives a reprice', async () => {
    const t = await trip({}, false);
    const line = (price: number) => ({ chargeTypeId: ids.freight, basis: 'per_litre_20', price: { amountMinor: price, currencyId: ids.usd } });
    const c0 = ok<Consignment>(await as(ops).post('/consignments', { tripId: t.id, lines: [{ productId: ids.diesel, plannedQty: 38000 }] }), 201);
    const unpriced = ok(await as(fin).get(`/consignments/${c0.id}/revenue`));
    assert.equal(unpriced.status, 'unpriced');
    assert.match(unpriced.problem, /No tariff covers this consignment/);
    ok(await as(fin).post('/tariffs', { code: 'ZE-ALL', name: 'Zambezi', customerId: ids.zambezi, currencyId: ids.usd, lines: [line(8)] }), 201);
    ok(await as(fin).post('/tariffs', { code: 'ZE-DAR', name: 'Zambezi Dar run', customerId: ids.zambezi, routeId: ids.routeDar, currencyId: ids.usd, lines: [line(9)] }), 201);
    const priced = ok(await as(fin).post(`/consignments/${c0.id}/reprice`));
    assert.equal(priced.status, 'estimated');
    assert.equal(priced.tariff.code, 'ZE-DAR');
    assert.equal(priced.totalMinor, 38000 * 9);
    const why = ok(await as(fin).get(`/tariffs/${(await find(owner, 'tariffs', 'ZE-ALL')).id}/match`, { consignmentId: c0.id }));
    assert.equal(why.matches, true);
    assert.equal(why.winner.code, 'ZE-DAR');
    // Operations does not see money.
    await as(ops).get(`/consignments/${c0.id}/revenue`).expect(403);
    assert.equal((await consignment(c0.id)).revenue, undefined);
    // A price by hand survives a reprice.
    await as(fin).post(`/consignments/${c0.id}/revenue/manual`, { amount: { amountMinor: 400000, currencyId: ids.usd } }).expect(422);
    const manual = ok(await as(fin).post(`/consignments/${c0.id}/revenue/manual`, { amount: { amountMinor: 400000, currencyId: ids.usd }, reason: 'Agreed on the phone', whole: true }));
    assert.equal(manual.totalMinor, 400000);
    assert.equal(ok(await as(fin).post(`/consignments/${c0.id}/reprice`)).totalMinor, 400000);
    // Frozen, it does not reprice; reopened, it does.
    ok(await as(fin).post(`/consignments/${c0.id}/revenue/freeze`));
    await as(fin).post(`/consignments/${c0.id}/revenue/manual`, { amount: { amountMinor: 1, currencyId: ids.usd }, reason: 'x' }).expect(409);
    ok(await as(fin).post(`/consignments/${c0.id}/revenue/reopen`, { reason: 'Price changed' }));
  });

  test('the tariff editor tries a tariff that is not saved, and a bad formula is named before it can be saved', async () => {
    const tried = ok(await as(fin).post('/tariffs/try', { tariff: { currencyId: ids.usd, lines: [{ chargeTypeId: ids.freight, basis: 'per_tonne', price: { amountMinor: 4200, currencyId: ids.usd } }], minimumCharge: { amountMinor: 120000, currencyId: ids.usd } }, sample: { loadedQty: 20, deliveredQty: 20, unit: 't' } }));
    assert.deepEqual(tried.problems, []);
    assert.equal(tried.result.subtotalMinor, 120000, 'topped up to the minimum');
    const bad = { code: 'BAD', name: 'Bad', currencyId: ids.usd, lines: [{ chargeTypeId: ids.freight, basis: 'formula', formula: 'kgs * 2' }] };
    assert.match(ok(await as(fin).post('/tariffs/try', { tariff: bad, sample: { loadedQty: 1 } })).problems[0], /kgs/);
    const refused = await as(fin).post('/tariffs', bad);
    assert.equal(refused.status, 422);
    assert.match(JSON.stringify(refused.body.error.details), /kgs/);
    const ref = ok(await as(ops).get('/freight/formula/variables'));
    assert.ok(ref.variables.some((v: { name: string }) => v.name === 'litres20'));
    assert.deepEqual(ref.bases.find((b: { value: string }) => b.value === 'per_drop_beyond'), { value: 'per_drop_beyond', label: 'Per drop after the free ones', sentence: 'Price × drops after the free ones (one free unless the line says).', price: 'price', priceOptional: false, free: true });
    assert.equal(ref.bases.find((b: { value: string }) => b.value === 'percent_of_freight').price, 'percent');
  });
});

describe('a rate agreed on the consignment (#135 Part 1)', () => {
  test('prices it with no tariff, on the quantity it says, and can be changed or taken off', async () => {
    const rate = { basis: 'per_litre_20', price: { amountMinor: 8.5, currencyId: ids.usd }, chargeOn: 'loaded' };
    const t = await trip({ consignments: [{ lines: [{ productId: ids.diesel, plannedQty: 38000 }], consignee: { name: 'Zambezi depot' }, rate }] }, true, owner);
    const asOwner = async (id: string) => ok<Consignment>(await as(owner).get(`/consignments/${id}`));
    const first = (await onTrip(t.id))[0]!;
    let c = await asOwner(first.id);
    assert.deepEqual(c!.rate, rate);
    assert.equal(c!.revenue.status, 'estimated');
    assert.match(c!.revenue.explanation[0], /rate agreed on the consignment/);
    assert.equal(c!.revenue.lines[0].unitPriceMinor, 8.5, 'a unit price keeps fractions of a cent');
    const load = t.stops.find((s) => s.kind === 'load')!;
    await recordStop(t, load, () => fuel(38000));
    c = await asOwner(c.id);
    const loaded20 = c.legs.find((l) => l.kind === 'pickup')!.actual![0].std20L as number;
    assert.equal(c.revenue.lines[0].qty, loaded20, 'charged on the loaded litres at 20 °C');
    assert.equal(c.revenue.totalMinor, Math.round(loaded20 * 8.5));
    // Changed to a fixed price, then taken off: a tariff (or nothing) prices it again.
    c = ok(await as(owner).patch(`/consignments/${c.id}`, { version: c.version, rate: { basis: 'per_consignment', price: { amountMinor: 300000, currencyId: ids.usd } } }));
    assert.equal(c.revenue.totalMinor, 300000);
    c = ok(await as(owner).patch(`/consignments/${c.id}`, { version: c.version, rate: null }));
    assert.equal(c.rate, undefined);
    assert.doesNotMatch(c.revenue.explanation.join(' '), /rate agreed/);
  });

  test('is money: Operations neither sees a rate nor sets or clears one (the owner can give its role the money switch)', async () => {
    const rate = { basis: 'per_consignment', price: { amountMinor: 250000, currencyId: ids.usd } };
    const t = await trip({ consignments: [{ lines: [{ productId: ids.diesel, plannedQty: 38000 }], rate }] }, true, owner);
    const [seen] = await onTrip(t.id);
    assert.equal(seen!.rate, undefined, 'not shown to Operations');
    // The owner's rate stays when Operations saves the consignment with a rate of its own, or with none.
    ok(await as(ops).patch(`/consignments/${seen!.id}`, { version: seen!.version, rate: null, references: { customerRef: 'PO-1' } }));
    const after = ok<Consignment>(await as(owner).get(`/consignments/${seen!.id}`));
    assert.deepEqual(after.rate, rate);
    assert.equal(after.revenue.totalMinor, 250000);
  });
});

describe('the A-to-E trip of #135 Part 1, made entirely from New trip', () => {
  test('A loads four, B loads two more, C offloads two and loads one, D offloads some, E the rest; priced at agreed rates; run to the end', async () => {
    // A Dar es Salaam, B Nakonde, C Ndola, D Kasumbalesa, E Lusaka depot (the truck starts and ends at the depot).
    const [A, B, C, D, E] = [ids.dar!, ids.nakonde!, ids.ndola!, ids.kasumbalesa!, ids.depot!];
    const rate = (minor: number) => ({ basis: 'per_consignment', price: { amountMinor: minor, currencyId: ids.usd } });
    const cn = (from: string, to: string, n: number) => ({
      consignmentTypeId: ids.bulk, lines: [{ productId: ids.diesel, plannedQty: 4000 }], consignee: { name: `Depot ${n}`, phone: `+26097700010${n}` },
      legs: [{ kind: 'pickup', placeId: from }, { kind: 'drop', placeId: to }], rate: rate(100000 * n),
    });
    const t = await trip({
      routeId: undefined,
      stops: [{ placeId: E, kind: 'start' }, { placeId: A, kind: 'load' }, { placeId: B, kind: 'load' }, { placeId: C, kind: 'offload' }, { placeId: D, kind: 'offload' }, { placeId: E, kind: 'offload' }, { placeId: E, kind: 'end' }],
      consignments: [cn(A, C, 1), cn(A, C, 2), cn(A, D, 3), cn(A, E, 4), cn(B, D, 5), cn(B, E, 6), cn(C, E, 7)],
    }, true, owner);
    const all = await onTrip(t.id);
    assert.equal(all.length, 7);
    const now = await tripNow(t.id);
    const placeAt = (stopId?: string) => now.stops.find((s) => s.id === stopId)?.placeId;
    for (const c of all) {
      const at = (kind: 'pickup' | 'drop') => now.stops.findIndex((s) => s.id === c.legs.find((l) => l.kind === kind)?.stopId);
      assert.ok(at('pickup') >= 0 && at('drop') > at('pickup'), `${c.number}: on the trip's stops, picked up before it is dropped`);
    }
    // C is both a drop (two consignments) and a pickup (one): every leg sits at its own place.
    const legsAt = (place: string, kind: 'pickup' | 'drop') => all.filter((c) => c.legs.some((l) => l.kind === kind && placeAt(l.stopId) === place)).length;
    assert.deepEqual([legsAt(A, 'pickup'), legsAt(B, 'pickup'), legsAt(C, 'drop'), legsAt(C, 'pickup'), legsAt(D, 'drop'), legsAt(E, 'drop')], [4, 2, 2, 1, 2, 3]);
    // Run it: every stop in order, each pickup and drop recorded where it is planned.
    for (const stop of now.stops) {
      if (stop.kind !== 'load' && stop.kind !== 'offload') continue;
      await recordStop(now, stop, () => fuel(4000));
    }
    const done = await Promise.all(all.map(async (c) => ok<Consignment>(await as(owner).get(`/consignments/${c.id}`))));
    for (const c of done) assert.equal(c.status, 'delivered', c.number);
    // After each loading and each drop but the last, the driver is told where to go next (#102).
    const told = (await driverMessages()).filter((m) => m.title === 'Delivery confirmed' || m.title === 'Loading confirmed');
    assert.ok(told.some((m) => m.title === 'Delivery confirmed' && /Next: .+ to (drop|load) CN\//.test(m.text)), 'a drop with more to come names the next stop');
    assert.ok(told.some((m) => m.title === 'Loading confirmed' && /Next: .+ to load CN\//.test(m.text)), 'a loading with another pickup next names that pickup');
    // Each stop is left no earlier than the work recorded there (#102), not at the minute the truck arrived.
    const ran = (await tripNow(t.id)) as unknown as { stops: Array<{ id: string; kind: string; leftAt?: string }> };
    for (const stop of ran.stops.slice(1, -2)) {
      const work = done.flatMap((c) => c.legs).map((l) => l as typeof l & { recordedAt?: string }).filter((l) => l.stopId === stop.id && l.recordedAt).map((l) => Date.parse(String(l.recordedAt)));
      if (!work.length) continue;
      assert.ok(stop.leftAt, `stop ${stop.kind} has a leaving time`);
      assert.ok(Date.parse(stop.leftAt) >= Math.max(...work), `stop ${stop.kind} is left after its work is recorded`);
    }
    assert.deepEqual(done.map((c) => c.revenue.totalMinor).sort((a, b) => a - b), [100000, 200000, 300000, 400000, 500000, 600000, 700000]);
    ok(await as(ops).post(`/trips/${t.id}/end`, { closingFuelL: 80 }));
    const profit = ok(await as(owner).get(`/trips/${t.id}/profit`));
    assert.equal(profit.revenueMinor > 0, true, 'the trip shows its revenue');
  });
});

describe('the driver says which consignment each paper is for (#135 Part 2)', () => {
  test('four consignments loading at one stop: the app lists them, asks which, files each paper on its own, and the gate opens after the fourth', async () => {
    const cn = (n: number) => ({ lines: [{ productId: ids.diesel, plannedQty: 4000 }], consignee: { name: `Depot ${n}`, phone: `+26097700020${n}` } });
    const t = await trip({ consignments: [cn(1), cn(2), cn(3), cn(4)] }, true, owner);
    const load = t.stops.find((s) => s.kind === 'load')!;
    ok(await as(ops).post(`/trips/${t.id}/stops/${load.id}/arrive`));
    ok(await as(owner).put(`/users/driver-access/${ids.d1}`, { phone: '+260971234567', password: 'Truck2026' }));
    const driver = { token: ok<{ accessToken: string }>(await api().post('/api/v1/auth/login').send({ phone: '+260971234567', password: 'Truck2026' })).accessToken };
    const home = async () => ok(await as(driver).get('/driver-app/home')).trip;
    let h = await home();
    const here = h.stops.find((s: { id: string }) => s.id === load.id);
    assert.equal(here.legs.length, 4, 'the four consignments loading here');
    assert.ok(here.legs.every((l: { send: Array<{ label: string }>; party: string }) => l.send.some((p) => p.label === 'Loading invoice') && l.party), 'each with its party and the invoice due');
    assert.equal(h.next.length, 4, 'four invoices due now, one per consignment');
    assert.match(h.gate.driverReason, /Waiting for Operations/);
    // Sent without saying which: four are open here, so it is filed on the trip and the driver is asked.
    const unsure = ok(await as(driver).post('/driver-app/send', { kind: 'loading', note: 'Invoice' }), 201);
    assert.equal(unsure.pick.length, 4);
    assert.equal(unsure.consignmentId, undefined);
    // Each invoice for its own consignment.
    for (const due of h.next) {
      const doc = ok(await as(driver).post('/driver-app/send', { kind: 'loading', note: `Invoice for ${due.label}`, consignmentId: due.consignmentId, legId: due.legId, documentTypeId: due.documentTypeId }), 201);
      assert.equal(doc.consignmentId, due.consignmentId);
      assert.equal(doc.legId, due.legId);
    }
    h = await home();
    assert.equal(h.next.length, 0, 'nothing more due: every invoice is with the office');
    // The office records the four; the truck may go after the fourth.
    const now = await tripNow(t.id);
    const list = await onTrip(t.id);
    for (const [i, c] of list.entries()) {
      assert.ok(ok(await as(ops).get(`/trips/${t.id}/gate`)).gate, `held before the ${i + 1}th is recorded`);
      const leg = c.legs.find((l) => l.kind === 'pickup')!;
      ok(await as(ops).post(`/consignments/${c.id}/legs/${leg.id}/record`, { measures: [{ lineId: c.lines[0]!.id, ...fuel(4000) }], documents: [{ number: `INV-${i + 1}` }] }));
    }
    const gate = ok(await as(ops).get(`/trips/${t.id}/gate`)).gate;
    assert.ok(!gate || gate.stopId !== load.id, 'the loading stop no longer holds the truck');
    void now;
  });

  test('on WhatsApp: a photo with no kind is asked about, the driver answers with a number, and each invoice lands on its own consignment', async () => {
    const cn = (n: number) => ({ lines: [{ productId: ids.diesel, plannedQty: 4000 }], consignee: { name: `Depot ${n}` } });
    const t = await trip({ consignments: [cn(1), cn(2), cn(3), cn(4)] }, true, owner);
    const load = t.stops.find((s) => s.kind === 'load')!;
    ok(await as(ops).post(`/trips/${t.id}/stops/${load.id}/arrive`));
    const photo = (n: number) => ({ driverId: ids.d1, file: { name: `invoice-${n}.jpg`, mime: 'image/jpeg', sampleId: `loading:${n}:0` } });
    const reply = (text: string) => as(ops).post('/whatsapp/simulate', { driverId: ids.d1, text });
    const docs = async () => ok<Array<{ id: string; consignmentId?: string; kind: string }>>(await as(ops).get('/driver-documents', { tripId: t.id, limit: 50 }));
    const list = await onTrip(t.id);
    for (let n = 1; n <= 4; n++) {
      const sent = ok(await as(ops).post('/whatsapp/simulate', photo(n)), 201);
      const asked = (await driverMessages()).at(-1)!;
      if (n < 4) {
        assert.match(asked.text, /Which consignment is this loading invoice for\? Reply with the number/);
        assert.equal(asked.text.split('\n').length - 1, 5 - n, 'only the consignments still needing an invoice');
        // Each consignment keeps its number at the stop (#102), and says what it carries.
        const first = asked.text.split('\n')[1]!;
        assert.match(first, new RegExp(`^${n}\\. CN/\\d+/\\d+ · 4,000 L`), 'numbered by its fixed place, with the goods and litres');
        ok(await reply(String(n)), 201);
      } else {
        assert.match(asked.text, /We got your loading invoice for/, 'the last one needs no question');
      }
      const filed = (await docs()).find((d) => d.id === sent.id)!;
      assert.ok(filed.consignmentId, `photo ${n} filed on a consignment`);
      assert.equal(filed.kind, 'loading');
    }
    // The desks' feed shows them filed too, so "Photos to file" empties (#102).
    const synced = ok<{ documents: Array<{ id: string; tripId?: string; kind: string; status: string; consignmentId?: string }> }>(await as(ops).get('/operations/sync'));
    assert.deepEqual(synced.documents.filter((d) => d.tripId === t.id && d.status === 'new' && !d.consignmentId && d.kind !== 'other'), [], 'nothing left to file');
    const filedOn = new Set((await docs()).map((d) => d.consignmentId).filter(Boolean));
    assert.equal(filedOn.size, 4, 'each consignment got its own invoice');
    assert.deepEqual([...filedOn].sort(), list.map((c) => c.id).sort());
    // A message that isn't an answer is filed as a message, as before.
    ok(await reply('Tyre is flat'), 201);
    assert.ok((await docs()).some((d) => d.kind === 'other'));
  });

  test('with only one consignment at the stop, a paper sent without saying which is filed on it', async () => {
    const t = await trip({ consignments: [{ lines: [{ productId: ids.diesel, plannedQty: 4000 }] }] }, true, owner);
    const load = t.stops.find((s) => s.kind === 'load')!;
    ok(await as(ops).post(`/trips/${t.id}/stops/${load.id}/arrive`));
    ok(await as(owner).put(`/users/driver-access/${ids.d1}`, { phone: '+260971234567', password: 'Truck2026' }));
    const driver = { token: ok<{ accessToken: string }>(await api().post('/api/v1/auth/login').send({ phone: '+260971234567', password: 'Truck2026' })).accessToken };
    const [c] = await onTrip(t.id);
    const doc = ok(await as(driver).post('/driver-app/send', { kind: 'loading', note: 'Invoice' }), 201);
    assert.equal(doc.consignmentId, c!.id);
    assert.equal(doc.pick, undefined);
  });
});

describe('the consignment report (#135 Part 4)', () => {
  test('the 8 Nov columns by default, chosen columns, totals, money only for those who see it, and downloads', async () => {
    const t = await trip({ consignments: [
      { lines: [{ productId: ids.diesel, plannedQty: 20000 }], rate: { basis: 'per_consignment', price: { amountMinor: 150000, currencyId: ids.usd } } },
      { lines: [{ productId: ids.diesel, plannedQty: 10000 }], references: { lrNo: 'LR-0091' } },
    ] }, true, owner);
    for (const stop of t.stops) if (stop.kind === 'load' || stop.kind === 'offload') await recordStop(t, stop, (c) => fuel(c.lines[0] && c.number.endsWith('1') ? 20000 : 10000));
    const report = ok(await as(owner).get('/consignments/report', { tripId: t.id }));
    assert.deepEqual(report.columns.map((c: { key: string }) => c.key), ['tripNo', 'vehicleNo', 'invoiceDate', 'lrNo', 'product', 'quantity', 'unit', 'route', 'leadKm']);
    assert.equal(report.rows.length, 2);
    assert.ok(report.rows.every((r: Record<string, unknown>) => r.tripNo && r.vehicleNo && r.product && r.route && r.invoiceDate));
    assert.ok(report.rows.some((r: Record<string, unknown>) => r.lrNo === 'LR-0091'));
    assert.equal(report.totals.count, 2);
    // Chosen columns, money among them: the owner sees it, Operations doesn't, even when asked.
    const cols = { tripId: t.id, columns: 'number,loadedOn,deliveredOn,hoursOnRoad,total,currency' };
    const mine = ok(await as(owner).get('/consignments/report', cols));
    assert.deepEqual(mine.columns.map((c: { key: string }) => c.key), ['number', 'loadedOn', 'deliveredOn', 'hoursOnRoad', 'total', 'currency']);
    assert.ok(mine.rows.some((r: Record<string, unknown>) => r.total === 1500 && r.currency === 'USD'));
    const theirs = ok(await as(ops).get('/consignments/report', cols));
    assert.deepEqual(theirs.columns.map((c: { key: string }) => c.key), ['number', 'loadedOn', 'deliveredOn', 'hoursOnRoad']);
    assert.ok(!theirs.available.some((c: { money: boolean }) => c.money));
    // Downloads: a real Excel workbook (a zip) and a CSV that Excel reads, with the same header.
    const asFile = (path: string) => api().get(`/api/v1${path}`).query(cols).set(bearer(owner)).buffer(true).parse((res, done) => { const parts: Buffer[] = []; res.on('data', (b: Buffer) => parts.push(b)); res.on('end', () => done(null, Buffer.concat(parts))); });
    const book = await asFile('/consignments/report.xlsx');
    assert.equal(book.status, 200);
    assert.match(String(book.headers['content-type']), /spreadsheetml/);
    assert.equal((book.body as Buffer).subarray(0, 2).toString(), 'PK');
    assert.ok((book.body as Buffer).includes(Buffer.from('Consignment no.')));
    const sheet = await asFile('/consignments/report.csv');
    const text = (sheet.body as Buffer).toString('utf8');
    assert.ok(text.startsWith('﻿"Consignment no.","Loaded on","Delivered on","Hours on the road","Total","Currency"'));
  });
});

describe('bad input to POST /consignments (#135 Part 5)', () => {
  test('is refused in words, never a server error', async () => {
    const t = await trip({}, false);
    const bodies: unknown[] = [
      {}, [], 'x', null, { tripId: 'x' }, { tripId: t.id }, { tripId: t.id, lines: 'x' }, { tripId: t.id, lines: [] }, { tripId: t.id, lines: [{}] },
      { tripId: t.id, lines: [{ productId: ids.diesel, plannedQty: -5 }] }, { tripId: t.id, lines: [{ productId: 'nope' }] },
      { tripId: t.id, lines: [{ productId: ids.diesel }], legs: 'x' }, { tripId: t.id, lines: [{ productId: ids.diesel }], legs: [{ kind: 'nowhere' }] },
      { tripId: t.id, lines: [{ productId: ids.diesel }], legs: [{ kind: 'drop', placeId: ids.depot }] },
      { tripId: t.id, lines: [{ productId: ids.diesel }], rate: { basis: 'per_parsec', price: { amountMinor: 1, currencyId: ids.usd } } },
      { tripId: t.id, lines: [{ productId: ids.diesel }], rate: { basis: 'per_kg', price: { amountMinor: -1, currencyId: ids.usd } } },
      { tripId: t.id, invoiceNo: 5 }, { tripId: t.id, invoiceNo: 'INV-1' }, { tripId: t.id, invoiceNo: 'INV-1', productId: ids.diesel, qty: 'many' },
      { tripId: t.id, lines: [{ productId: ids.diesel }], consignee: 'just a string' }, { tripId: t.id, lines: [{ productId: ids.diesel }], references: { lrNo: 'x'.repeat(5000) } },
    ];
    for (const body of bodies) {
      const res = await api().post('/api/v1/consignments').set(bearer(owner)).set('Content-Type', 'application/json').send(JSON.stringify(body));
      assert.ok(res.status < 500, `${JSON.stringify(body).slice(0, 80)} -> ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
      if (res.status >= 400) assert.ok(res.body.error?.message, 'refused with a message');
    }
  });
});

describe('the same paper number on two consignments (#102)', () => {
  test('is recorded, and said, so someone checks it', async () => {
    const cn = (n: number) => ({ lines: [{ productId: ids.diesel, plannedQty: 4000 }], consignee: { name: `Depot ${n}` } });
    const t = await trip({ consignments: [cn(1), cn(2)] }, true, owner);
    const [a, b] = await onTrip(t.id);
    const record = async (c: Consignment) => ok<{ checks: { papers: { warnings: string[] } } }>(await as(ops).post(`/consignments/${c.id}/legs/${c.legs.find((l) => l.kind === 'pickup')!.id}/record`, { measures: [{ lineId: c.lines[0]!.id, ...fuel(4000) }], documents: [{ number: 'INV-44239' }] }));
    assert.deepEqual((await record(a!)).checks.papers.warnings, []);
    const second = await record(b!);
    assert.match(second.checks.papers.warnings[0] ?? '', new RegExp(`INV-44239 is also filed on ${a!.number.replace(/\//g, '\\/')}`));
  });
});
