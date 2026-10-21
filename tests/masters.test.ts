import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { api, bearer, errorCode, loadSample, signUp, startDatabase, stopDatabase, type Session } from './helpers.js';

/**
 * The same contract checked against every master the API registers (read from /meta/masters),
 * so a master added later is covered automatically.
 */
let owner: Session;
let masters: Array<Record<string, any>> = [];
const MISSING_ID = '0123456789abcdef01234567';

before(async () => {
  await startDatabase();
  owner = await signUp('Owner');
  await loadSample(owner);
  masters = (await api().get('/api/v1/meta/masters').set(bearer(owner)).expect(200)).body.data;
});
after(stopDatabase);

const standard = () => masters.filter((m) => m.key !== 'custom-records');

describe('registry', () => {
  test('every master is described with fields, endpoints and request schemas', () => {
    assert.ok(masters.length >= 54, `only ${masters.length} masters`);
    for (const m of masters) {
      assert.ok(m.label && m.group && m.description, `${m.key} lacks a label, group or description`);
      assert.ok(m.fields.length > 5, `${m.key} has no fields`);
      assert.ok(m.createSchema?.type === 'object', `${m.key} has no create schema`);
      if (m.key !== 'custom-records') assert.ok(m.endpoints.some((e: { method: string }) => e.method === 'GET'), `${m.key} has no GET`);
      for (const e of m.endpoints) assert.ok(e.permission, `${e.method} ${e.path} has no permission`);
      for (const r of m.references) assert.ok(masters.some((x) => x.key === r.target) || ['users', 'roles'].includes(r.target), `${m.key}.${r.path} points at unknown ${r.target}`);
    }
  });

  test('sample data covers every master except a few optional ones', async () => {
    const stats = (await api().get('/api/v1/meta/stats').set(bearer(owner)).expect(200)).body.data as Array<{ key: string; total: number }>;
    const empty = stats.filter((s) => s.total === 0).map((s) => s.key).sort();
    assert.deepEqual(empty, []);
  });
});

describe('list endpoints', () => {
  test('return the paginated envelope and reject bad parameters', async () => {
    for (const m of standard()) {
      const base = `/api/v1/${m.key}`;
      const ok = await api().get(base).query({ page: 1, limit: 5 }).set(bearer(owner));
      assert.equal(ok.status, 200, `${m.key}: ${JSON.stringify(ok.body)}`);
      assert.equal(ok.body.success, true);
      assert.ok(Array.isArray(ok.body.data));
      assert.deepEqual(Object.keys(ok.body.meta).sort(), ['hasNextPage', 'hasPrevPage', 'limit', 'page', 'total', 'totalPages']);
      for (const row of ok.body.data) {
        assert.match(row.id, /^[0-9a-f]{24}$/);
        assert.equal(row._id, undefined);
        assert.equal(typeof row.version, 'number');
        assert.equal(row.geo, undefined);
      }
      for (const query of [{ unknownParam: 1 }, { limit: 0 }, { limit: 101 }, { page: 0 }, { page: 'x' }, { status: 'deleted' }, { sort: 'nonsense' }, { search: 'x'.repeat(101) }, { updatedSince: 'yesterday' }]) {
        const bad = await api().get(base).query(query).set(bearer(owner));
        assert.equal(bad.status, 422, `${m.key} accepted ${JSON.stringify(query)}`);
        assert.equal(errorCode(bad), 'VALIDATION_ERROR');
      }
      for (const sort of m.sortFields) {
        await api().get(base).query({ sort: `-${sort}`, limit: 2 }).set(bearer(owner)).expect(200);
      }
      for (const status of ['active', 'inactive', 'archived', 'all']) await api().get(base).query({ status }).set(bearer(owner)).expect(200);
    }
  });

  test('search treats regular-expression characters literally', async () => {
    for (const m of standard()) {
      for (const search of ['.*', '[a-z', '\\', '$where', '^ZM$|.*', '(?=x)']) {
        const r = await api().get(`/api/v1/${m.key}`).query({ search }).set(bearer(owner));
        assert.equal(r.status, 200, `${m.key} search ${search}: ${r.status}`);
        assert.equal(r.body.meta.total, 0, `${m.key} search ${search} matched ${r.body.meta.total}`);
      }
    }
    const literal = await api().get('/api/v1/vehicle-types').query({ search: '(horse)' }).set(bearer(owner)).expect(200);
    assert.equal(literal.body.meta.total, 1);
  });

  test('pagination is stable and complete', async () => {
    const all = await api().get('/api/v1/places').query({ limit: 100, sort: 'code' }).set(bearer(owner)).expect(200);
    const seen: string[] = [];
    for (let page = 1; page <= all.body.meta.total; page += 1) {
      const r = await api().get('/api/v1/places').query({ limit: 1, page, sort: 'code' }).set(bearer(owner)).expect(200);
      seen.push(r.body.data[0].id);
    }
    assert.deepEqual(seen, all.body.data.map((p: { id: string }) => p.id));
    const beyond = await api().get('/api/v1/places').query({ page: 999 }).set(bearer(owner)).expect(200);
    assert.deepEqual(beyond.body.data, []);
  });

  test('filters narrow results and reject wrong types', async () => {
    for (const m of standard()) {
      for (const f of m.filters) {
        const sample = f.schema?.enum?.[0] ?? (f.schema?.pattern?.includes('a-fA-F') ? MISSING_ID : f.schema?.type === 'number' || f.schema?.type === 'integer' ? 30 : f.key === 'entity' ? 'drivers' : 'true');
        const r = await api().get(`/api/v1/${m.key}`).query({ [f.key]: sample }).set(bearer(owner));
        assert.equal(r.status, 200, `${m.key}?${f.key}=${sample}: ${JSON.stringify(r.body)}`);
      }
    }
    const tankers = await api().get('/api/v1/places').query({ type: 'border' }).set(bearer(owner)).expect(200);
    assert.ok(tankers.body.data.length >= 2 && tankers.body.data.every((p: { type: string }) => p.type === 'border'));
    await api().get('/api/v1/places').query({ type: 'volcano' }).set(bearer(owner)).expect(422);
    await api().get('/api/v1/vehicles').query({ vehicleTypeId: 'abc' }).set(bearer(owner)).expect(422);
  });
});

describe('record endpoints', () => {
  test('ids are validated and unknown records are 404', async () => {
    for (const m of standard()) {
      const base = `/api/v1/${m.key}`;
      assert.equal((await api().get(`${base}/not-an-id`).set(bearer(owner))).status, 422, m.key);
      assert.equal((await api().get(`${base}/${MISSING_ID}`).set(bearer(owner))).status, 404, m.key);
      assert.equal((await api().get(`${base}/${MISSING_ID}/usage`).set(bearer(owner))).status, 404, m.key);
      assert.equal((await api().get(`${base}/${MISSING_ID}/history`).set(bearer(owner))).status, 404, m.key);
      if (!m.managed.update) assert.equal((await api().patch(`${base}/${MISSING_ID}`).set(bearer(owner)).send({ version: 0, notes: 'x' })).status, 404, m.key);
      if (!m.managed.archive) assert.equal((await api().post(`${base}/${MISSING_ID}/archive`).set(bearer(owner))).status, 404, m.key);
      if (!m.managed.delete) assert.equal((await api().delete(`${base}/${MISSING_ID}`).set(bearer(owner))).status, 404, m.key);
    }
  });

  test('create bodies are strict: empty, unknown fields and operator keys are rejected', async () => {
    for (const m of standard()) {
      const base = `/api/v1/${m.key}`;
      const empty = await api().post(base).set(bearer(owner)).send({});
      assert.equal(empty.status, 422, `${m.key} accepted {}: ${JSON.stringify(empty.body)}`);
      const unknown = await api().post(base).set(bearer(owner)).send({ definitelyNotAField: 1 });
      assert.equal(unknown.status, 422, `${m.key} unknown field`);
      const operator = await api().post(base).set(bearer(owner)).send({ name: { $gt: '' } });
      assert.equal(operator.status, 400, `${m.key} operator key`);
      const dotted = await api().post(base).set(bearer(owner)).send({ 'name.first': 'x' });
      assert.equal(dotted.status, 400, `${m.key} dotted key`);
      const proto = await api().post(base).set(bearer(owner)).set('Content-Type', 'application/json').send('{"__proto__":{"admin":true}}');
      assert.ok([400, 422].includes(proto.status), `${m.key} __proto__ ${proto.status}`);
      const array = await api().post(base).set(bearer(owner)).send([1, 2]);
      assert.equal(array.status, 422, `${m.key} array body`);
    }
  });

  test('updates need the current version, reject unknown fields, and are audited', async () => {
    for (const m of standard().filter((x) => !x.managed.update)) {
      const base = `/api/v1/${m.key}`;
      const list = await api().get(base).query({ limit: 50 }).set(bearer(owner)).expect(200);
      const rec = list.body.data.find((r: { isSystem?: boolean; id: string }) => !r.isSystem && r.id !== owner.userId);
      if (!rec) continue;
      await api().patch(`${base}/${rec.id}`).set(bearer(owner)).send({ notes: 'x' }).expect(422);
      await api().patch(`${base}/${rec.id}`).set(bearer(owner)).send({ version: rec.version }).expect(422);
      await api().patch(`${base}/${rec.id}`).set(bearer(owner)).send({ version: rec.version, nope: 1 }).expect(422);
      await api().patch(`${base}/${rec.id}`).set(bearer(owner)).send({ version: rec.version, status: 'archived' }).expect(422);
      await api().patch(`${base}/${rec.id}`).set(bearer(owner)).send({ version: rec.version, status: null }).expect(422);
      const updated = await api().patch(`${base}/${rec.id}`).set(bearer(owner)).send({ version: rec.version, notes: `Checked by the contract test (${m.key})` });
      assert.equal(updated.status, 200, `${m.key}: ${JSON.stringify(updated.body)}`);
      assert.equal(updated.body.data.version, rec.version + 1);
      assert.equal(updated.body.data.updatedBy, owner.userId);
      const stale = await api().patch(`${base}/${rec.id}`).set(bearer(owner)).send({ version: rec.version, notes: 'stale' });
      assert.equal(stale.status, 409, `${m.key} stale version accepted`);
      assert.equal(stale.body.error.details.currentVersion, rec.version + 1);
      const same = await api().patch(`${base}/${rec.id}`).set(bearer(owner)).send({ version: rec.version + 1, notes: `Checked by the contract test (${m.key})` }).expect(200);
      assert.equal(same.body.data.version, rec.version + 1, `${m.key} no-op update bumped the version`);
      const cleared = await api().patch(`${base}/${rec.id}`).set(bearer(owner)).send({ version: rec.version + 1, notes: null }).expect(200);
      assert.equal(cleared.body.data.notes, undefined);
      const history = await api().get(`${base}/${rec.id}/history`).set(bearer(owner)).expect(200);
      assert.ok(history.body.data.some((h: { action: string; changes: Array<{ path: string }> }) => h.action === 'update' && h.changes.some((c) => c.path === 'notes')), `${m.key} update not audited`);
    }
  });

  test('archive and restore follow the usage rule', async () => {
    for (const m of standard().filter((x) => !x.managed.archive)) {
      const base = `/api/v1/${m.key}`;
      const list = await api().get(base).query({ limit: 50 }).set(bearer(owner)).expect(200);
      for (const rec of list.body.data.slice(0, 3)) {
        if (rec.isSystem || rec.id === owner.userId) continue;
        const usage = (await api().get(`${base}/${rec.id}/usage`).set(bearer(owner)).expect(200)).body.data;
        const archived = await api().post(`${base}/${rec.id}/archive`).set(bearer(owner)).send({ reason: 'Contract test' });
        if (usage.usage.length && m.key !== 'users') {
          const activeUse = archived.status === 409;
          if (activeUse) { assert.ok(archived.body.error.details.usage.length, `${m.key} 409 without usage details`); continue; }
        }
        assert.equal(archived.status, 200, `${m.key} archive: ${JSON.stringify(archived.body)}`);
        assert.equal(archived.body.data.status, 'archived');
        assert.equal(archived.body.data.archiveReason, 'Contract test');
        await api().post(`${base}/${rec.id}/archive`).set(bearer(owner)).expect(409);
        await api().patch(`${base}/${rec.id}`).set(bearer(owner)).send({ version: archived.body.data.version, notes: 'x' }).expect(409);
        const hidden = await api().get(base).query({ limit: 100 }).set(bearer(owner)).expect(200);
        assert.ok(!hidden.body.data.some((r: { id: string }) => r.id === rec.id), `${m.key} archived record still listed by default`);
        const restored = await api().post(`${base}/${rec.id}/restore`).set(bearer(owner)).expect(200);
        assert.equal(restored.body.data.status, 'active');
        await api().post(`${base}/${rec.id}/restore`).set(bearer(owner)).expect(409);
      }
    }
  });

  test('referenced records cannot be deleted; unreferenced ones can, and history survives', async () => {
    const zm = (await api().get('/api/v1/countries').query({ search: 'ZM' }).set(bearer(owner))).body.data[0];
    const blocked = await api().delete(`/api/v1/countries/${zm.id}`).set(bearer(owner)).expect(409);
    assert.ok(blocked.body.error.details.usage.some((u: { master: string }) => u.master === 'provinces'));
    const fresh = await api().post('/api/v1/order-sources').set(bearer(owner)).send({ code: 'TEMP', name: 'Temporary' }).expect(201);
    await api().delete(`/api/v1/order-sources/${fresh.body.data.id}`).set(bearer(owner)).expect(204);
    await api().get(`/api/v1/order-sources/${fresh.body.data.id}`).set(bearer(owner)).expect(404);
    const history = await api().get(`/api/v1/order-sources/${fresh.body.data.id}/history`).set(bearer(owner)).expect(200);
    assert.deepEqual(history.body.data.map((h: { action: string }) => h.action), ['delete', 'create']);
  });
});
