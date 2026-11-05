import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import mongoose from 'mongoose';
import { api, bearer, find, loadSample, signUp, startDatabase, stopDatabase, type Session } from './helpers.js';

let owner: Session;
before(async () => {
  await startDatabase();
  owner = await signUp('Owner');
  await loadSample(owner);
});
after(stopDatabase);

const post = (path: string, body: unknown) => api().post(`/api/v1${path}`).set(bearer(owner)).send(body as object);
const statuses = (rs: Array<{ status: number }>) => rs.reduce<Record<number, number>>((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});

describe('concurrency', () => {
  test('40 simultaneous creates with one code: exactly one wins', async () => {
    const rs = await Promise.all(Array.from({ length: 40 }, (_, i) => post('/vehicle-makes', { code: 'RACE', name: `Race ${i}` })));
    assert.deepEqual(statuses(rs), { 201: 1, 409: 39 });
  });

  test('30 simultaneous auto-coded parties all get distinct codes', async () => {
    const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => post('/parties', { name: `Parallel ${i}`, roles: ['supplier'] })));
    assert.deepEqual(statuses(rs), { 201: 30 });
    const codes = rs.map((r) => r.body.data.code);
    assert.equal(new Set(codes).size, 30);
  });

  test('25 simultaneous numbers from one series are distinct and consecutive', async () => {
    const series = await find(owner, 'numbering-series', 'TRIPS');
    const rs = await Promise.all(Array.from({ length: 25 }, () => post(`/numbering-series/${series.id}/next`, {})));
    const numbers = rs.map((r) => r.body.data.number).sort((a: number, b: number) => a - b);
    assert.equal(new Set(numbers).size, 25);
    assert.equal(numbers[24] - numbers[0], 24);
  });

  test('12 simultaneous edits of one version: exactly one is saved', async () => {
    const make = await find(owner, 'vehicle-makes', 'VOLVO');
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => api().patch(`/api/v1/vehicle-makes/${make.id}`).set(bearer(owner)).send({ version: make.version, name: `Volvo ${i}` })));
    assert.deepEqual(statuses(rs), { 200: 1, 409: 11 });
    const after = await api().get(`/api/v1/vehicle-makes/${make.id}`).set(bearer(owner));
    assert.equal(after.body.data.version, make.version + 1);
  });

  test('10 simultaneous archives of one record: exactly one succeeds', async () => {
    const src = await post('/order-sources', { code: 'ARCHRACE', name: 'Archive race' }).expect(201);
    const rs = await Promise.all(Array.from({ length: 10 }, () => post(`/order-sources/${src.body.data.id}/archive`, {})));
    assert.equal(statuses(rs)[200], 1);
  });

  test('simultaneous pairings never leave a truck or trailer in two open pairings', async () => {
    const make = await find(owner, 'vehicle-makes', 'SCANIA');
    const prime = await find(owner, 'vehicle-types', 'PRIME');
    const flat = await find(owner, 'trailer-types', 'FLATBED');
    const trucks = await Promise.all([1, 2, 3].map((n) => post('/vehicles', { code: `PT${n}`, registrationNumber: `PAIR ${n}`, makeId: make.id, vehicleTypeId: prime.id }).expect(201)));
    const trailers = await Promise.all([1, 2, 3].map((n) => post('/trailers', { code: `PTR${n}`, registrationNumber: `PTRL ${n}`, trailerTypeId: flat.id, capacityKg: 30000 }).expect(201)));
    const attempts = trucks.flatMap((t) => trailers.map((tr) => post('/pairings', { vehicleId: t.body.data.id, trailerId: tr.body.data.id })));
    const rs = await Promise.all(attempts);
    assert.ok(rs.every((r) => [201, 409].includes(r.status)), JSON.stringify(statuses(rs)));
    const open = await mongoose.connection.db!.collection('pairings').find({ open: true }).toArray();
    const byVehicle = new Map<string, number>();
    const byTrailer = new Map<string, number>();
    for (const p of open) {
      byVehicle.set(String(p.vehicleId), (byVehicle.get(String(p.vehicleId)) ?? 0) + 1);
      byTrailer.set(String(p.trailerId), (byTrailer.get(String(p.trailerId)) ?? 0) + 1);
    }
    assert.ok([...byVehicle.values(), ...byTrailer.values()].every((n) => n === 1));
    for (const p of open) {
      const v = await mongoose.connection.db!.collection('vehicles').findOne({ _id: p.vehicleId });
      assert.equal(String(v!.currentTrailerId), String(p.trailerId), 'vehicle.currentTrailerId out of step');
    }
  });
});

describe('load', () => {
  test('600 list and detail reads at 30 concurrent stay fast and error-free', async () => {
    const keys = ['vehicles', 'drivers', 'places', 'parties', 'routes', 'products', 'compliance-documents', 'trip-stages', 'message-templates', 'currencies'];
    const ids = await Promise.all(keys.map(async (k) => (await api().get(`/api/v1/${k}`).set(bearer(owner))).body.data[0].id as string));
    const timings: number[] = [];
    let failures = 0;
    for (let batch = 0; batch < 20; batch += 1) {
      await Promise.all(Array.from({ length: 30 }, async (_, i) => {
        const k = keys[(batch * 30 + i) % keys.length]!;
        const path = i % 2 ? `/api/v1/${k}` : `/api/v1/${k}/${ids[keys.indexOf(k)]}`;
        const t = performance.now();
        const r = await api().get(path).query(i % 3 ? {} : { search: 'a', sort: '-createdAt' }).set(bearer(owner));
        timings.push(performance.now() - t);
        if (r.status !== 200) failures += 1;
      }));
    }
    timings.sort((a, b) => a - b);
    const p95 = timings[Math.floor(timings.length * 0.95)]!;
    assert.equal(failures, 0);
    assert.equal(timings.length, 600);
    assert.ok(p95 < 1500, `p95 ${Math.round(p95)} ms`);
  });

  test('200 creates in a row keep the audit trail complete', async () => {
    const before = await mongoose.connection.db!.collection('auditlogs').countDocuments({ entity: 'cancellation-reasons' });
    const sample = (await api().get('/api/v1/cancellation-reasons').query({ limit: 1 }).set(bearer(owner)).expect(200)).body.meta.total as number;
    for (let i = 0; i < 200; i += 1) await post('/cancellation-reasons', { code: `BULK-${i}`, name: `Bulk ${i}`, appliesTo: ['trip'] }).expect(201);
    const after = await mongoose.connection.db!.collection('auditlogs').countDocuments({ entity: 'cancellation-reasons' });
    assert.equal(after - before, 200);
    const list = await api().get('/api/v1/cancellation-reasons').query({ limit: 100, page: 3 }).set(bearer(owner)).expect(200);
    assert.equal(list.body.meta.total, 200 + sample);
    assert.equal(list.body.data.length, sample);
  });
});

describe('limits and hostile input', () => {
  test('size, depth and array limits', async () => {
    await post('/order-sources', { code: 'BIG', name: 'x', notes: 'a'.repeat(1024 * 1024) }).expect(413);
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 25; i += 1) deep = { n: deep };
    await post('/order-sources', { code: 'DEEP', name: 'Deep', custom: { deep } }).expect(400);
    await post('/order-sources', { code: 'TAGS', name: 'Tags', tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }).expect(422);
    await post('/order-sources', { code: 'NOTES', name: 'Notes', notes: 'n'.repeat(2001) }).expect(422);
    await post('/order-sources', { code: 'X'.repeat(33), name: 'Long code' }).expect(422);
    await post('/order-sources', { code: 'UNI', name: 'Ünïcödé ✓ 北京 مرحبا' }).expect(201);
    await post('/order-sources', { code: 'NUL', name: 'Null\u0000byte' }).expect(201);
  });

  test('type confusion is rejected, never crashes', async () => {
    const bodies = [null, 'string', 42, true, [], { code: 1, name: 2 }, { code: ['A'], name: 'x' }, { code: 'A', name: 'x', status: 'archived' }, { code: 'A', name: 'x', validFrom: 'tomorrow' }, { code: 'A', name: 'x', branchIds: ['not-id'] }];
    for (const body of bodies) {
      const r = await api().post('/api/v1/order-sources').set(bearer(owner)).set('Content-Type', 'application/json').send(JSON.stringify(body));
      assert.ok(r.status >= 400 && r.status < 500, `${JSON.stringify(body)} gave ${r.status}`);
    }
    await api().post('/api/v1/order-sources').set(bearer(owner)).set('Content-Type', 'text/plain').send('code=A').expect(422);
    await api().get('/api/v1/order-sources').query('status=active&status=all').set(bearer(owner)).expect(422);
    await api().get('/api/v1/order-sources').query('page[$gt]=1').set(bearer(owner)).expect(422);
  });
});

/* ---------- Fuzzing every endpoint ---------- */

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

const JUNK: unknown[] = [
  null, '', ' ', 'x'.repeat(300), '<script>alert(1)</script>', '../../etc/passwd', '0123456789abcdef01234567', 'ZZZZZZZZZZZZZZZZZZZZZZZZ',
  -1, 0, 1.5, 1e308, -1e308, Number.MAX_SAFE_INTEGER, true, false, [], [null], [1, 'a', {}], {}, { a: 1 }, { $ne: null }, '2026-13-45', '9999-12-31T23:59:59Z',
  '+260971234567', 'not-an-email', '😀'.repeat(50), 'NaN', '{"a":1}',
];

function junkValue(r: () => number, depth = 0): unknown {
  const pick = JUNK[Math.floor(r() * JUNK.length)];
  if (depth < 2 && r() < 0.2) return { k: junkValue(r, depth + 1), list: [junkValue(r, depth + 1)] };
  return pick;
}

function junkBody(r: () => number, schema: Record<string, any> | undefined): unknown {
  if (r() < 0.1) return JUNK[Math.floor(r() * JUNK.length)];
  const props = Object.keys(schema?.properties ?? {});
  const body: Record<string, unknown> = {};
  for (const key of props) if (r() < 0.6) body[key] = junkValue(r);
  if (r() < 0.2) body[`junk${Math.floor(r() * 9)}`] = junkValue(r);
  return body;
}

describe('fuzzing', () => {
  test('random input to every endpoint never produces a 500', async () => {
    const r = rng(20261021);
    const masters = (await api().get('/api/v1/meta/masters').set(bearer(owner))).body.data as Array<Record<string, any>>;
    const overview = (await api().get('/api/v1/meta/overview').set(bearer(owner))).body.data;
    const realIds = new Map<string, string[]>();
    for (const m of masters) {
      if (m.key === 'custom-records') continue;
      const list = await api().get(`/api/v1/${m.key}`).query({ limit: 3, status: 'all' }).set(bearer(owner));
      realIds.set(m.key, list.body.data.map((x: { id: string }) => x.id));
    }
    const skip = /\/auth\/(logout|logout-all|change-password)$|revoke-sessions$|\/meta\/sample-data$/;
    const endpoints = [...overview.endpoints, ...masters.flatMap((m) => m.endpoints)].filter((e: { path: string }) => !skip.test(e.path));
    let session = owner;
    let calls = 0;
    const failures: string[] = [];
    for (const e of endpoints as Array<{ method: string; path: string; schemas: Record<string, any> }>) {
      const masterKey = e.path.split('/')[3] ?? '';
      for (let i = 0; i < 12; i += 1) {
        const pool = realIds.get(masterKey) ?? [];
        const idChoice = () => (r() < 0.5 && pool.length ? pool[Math.floor(r() * pool.length)]! : String(junkValue(r) ?? 'x'));
        const path = e.path.replace(/:masterId/g, () => (realIds.get('custom-masters') ?? ['x'])[0]!).replace(/:id|:code/g, () => encodeURIComponent(idChoice()));
        const query: Record<string, string> = {};
        for (const key of Object.keys(e.schemas.query?.properties ?? { page: 1 })) if (r() < 0.5) query[key] = String(junkValue(r));
        let req = api()[e.method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete'](path).query(query).set(bearer(session));
        if (['POST', 'PATCH', 'PUT'].includes(e.method)) req = req.set('Content-Type', 'application/json').send(JSON.stringify(junkBody(r, e.schemas.body)));
        const res = await req;
        calls += 1;
        if (res.status >= 500) failures.push(`${e.method} ${path} -> ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
        if (res.status !== 204 && res.status < 500) {
          assert.equal(typeof res.body.success, 'boolean', `${e.method} ${path} returned no envelope`);
          if (res.status >= 400) assert.ok(res.body.error?.code && res.body.requestId, `${e.method} ${path} error without code`);
        }
        if (res.status === 401) {
          const login = await api().post('/api/v1/auth/login').send({ email: owner.email, password: owner.password });
          if (login.status === 200) session = { ...owner, token: login.body.data.accessToken };
        }
      }
    }
    assert.deepEqual(failures, []);
    assert.ok(calls > 2000, `only ${calls} fuzz calls`);
  });
});
