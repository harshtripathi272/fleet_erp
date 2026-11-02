import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { api, bearer, loadSample, signUp, startDatabase, stopDatabase, userWithRole, type Session } from './helpers.js';

/**
 * What a generic master screen does, run against every master: clone a record through the API,
 * find it by search, save the form unchanged, edit it, archive, restore and delete it.
 * Then the permission matrix of every built-in role against every master.
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

/** The fields a form may send: those the create schema accepts. */
function writable(def: Record<string, any>, record: Record<string, any>) {
  return Object.fromEntries(Object.keys(def.createSchema.properties ?? {}).filter((k) => record[k] !== undefined).map((k) => [k, record[k]]));
}

/** Changes the free-text values that must be unique so a copy can be saved. */
function makeUnique(def: Record<string, any>, body: Record<string, any>, tag: string) {
  const plainText = (path: string) => {
    const info = def.fields.find((f: { path: string }) => f.path === path);
    return info && info.type === 'string' && !info.enum && !info.ref && !['entity', 'language', 'key'].includes(path);
  };
  const unique = (def.indexes as Array<{ unique?: boolean; fields: Record<string, number> }>).filter((i) => i.unique).flatMap((i) => Object.keys(i.fields));
  for (const path of new Set(['code', 'name', 'registrationNumber', 'vin', 'engineNumber', ...unique])) {
    if (typeof body[path] === 'string' && plainText(path)) body[path] = `${body[path]}${tag}`.slice(-30);
  }
  const special: Record<string, () => void> = {
    countries: () => Object.assign(body, { code: 'QX', iso3: 'QXX' }),
    currencies: () => Object.assign(body, { code: 'QXX' }),
    'trip-types': () => Object.assign(body, { isDefault: false }),
    'field-definitions': () => Object.assign(body, { key: `${body.key}${tag.toLowerCase()}` }),
    'exchange-rates': () => Object.assign(body, { effectiveDate: '2031-01-01' }),
    parties: () => delete body.taxId,
  };
  special[def.key]?.();
  delete body.status;
  return body;
}

describe('every master through the API, as a screen uses it', () => {
  test('clone, search, save unchanged, edit, usage, history, archive, restore, delete', async () => {
    const conflicts: string[] = [];
    for (const def of masters.filter((m) => !['users', 'custom-records', 'roles'].includes(m.key) && !m.managed.create)) {
      const base = `/api/v1/${def.key}`;
      const sample = (await api().get(base).query({ limit: 5 }).set(bearer(owner)).expect(200)).body.data.find((r: { isSystem?: boolean }) => !r.isSystem);
      assert.ok(sample, `${def.key} has no sample record`);
      const created = await api().post(base).set(bearer(owner)).send(makeUnique(def, writable(def, sample), 'WT'));
      // A unique rule that a copy cannot satisfy (one head office, one policy per product) is a correct 409.
      if (created.status === 409) {
        assert.ok(created.body.error.details.fields.length, `${def.key} 409 without the clashing fields`);
        conflicts.push(def.key);
      } else assert.equal(created.status, 201, `${def.key} create: ${JSON.stringify(created.body)}`);
      const record = created.status === 201 ? created.body.data : sample;

      const title = record[def.titleField];
      if (created.status === 201 && typeof title === 'string' && def.searchFields.includes(def.titleField)) {
        const found = await api().get(base).query({ search: title, limit: 100 }).set(bearer(owner)).expect(200);
        assert.ok(found.body.data.some((r: { id: string }) => r.id === record.id), `${def.key} search for "${title}" missed the record`);
      }

      const unchanged = await api().patch(`${base}/${record.id}`).set(bearer(owner)).send({ ...writable(def, record), version: record.version });
      assert.equal(unchanged.status, 200, `${def.key} saving the form unchanged: ${JSON.stringify(unchanged.body)}`);
      assert.equal(unchanged.body.data.version, record.version, `${def.key} unchanged save bumped the version`);
      await api().patch(`${base}/${record.id}`).set(bearer(owner)).send({ notes: 'Walkthrough', version: record.version }).expect(200);
      if (created.status !== 201) continue;

      const usage = (await api().get(`${base}/${record.id}/usage`).set(bearer(owner)).expect(200)).body.data;
      assert.equal(usage.total, 0, `${def.key} new record already in use`);
      const history = (await api().get(`${base}/${record.id}/history`).set(bearer(owner)).expect(200)).body.data;
      assert.deepEqual(history.map((h: { action: string }) => h.action), ['update', 'create'], def.key);
      if (!def.managed.archive) {
        await api().post(`${base}/${record.id}/archive`).set(bearer(owner)).send({ reason: 'Walkthrough' }).expect(200);
        await api().post(`${base}/${record.id}/restore`).set(bearer(owner)).expect(200);
      }
      if (!def.managed.delete) await api().delete(`${base}/${record.id}`).set(bearer(owner)).expect(204);
    }
    assert.ok(conflicts.length < 15, `too many masters could not be copied: ${conflicts.join(', ')}`);
  });

  test('a link to an archived record is refused', async () => {
    const type = (await api().post('/api/v1/vehicle-types').set(bearer(owner)).send({ code: 'WT-ARCH', name: 'Walkthrough type', category: 'prime_mover' })).body.data;
    assert.ok(type?.id, 'vehicle type not created');
    await api().post(`/api/v1/vehicle-types/${type.id}/archive`).set(bearer(owner)).send({}).expect(200);
    const res = await api().post('/api/v1/fuel-norms').set(bearer(owner)).send({ vehicleTypeId: type.id, kmPerLLoaded: 2, kmPerLEmpty: 3 });
    assert.equal(res.status, 422);
    assert.ok(res.body.error.details.references.vehicleTypeId, JSON.stringify(res.body));
  });
});

describe('built-in role permissions on every master', () => {
  test('read, create, update, archive, delete and sensitive follow each role', async () => {
    const sessions: Record<string, Session> = { owner };
    for (const key of ['admin', 'operations', 'finance', 'viewer']) sessions[key] = await userWithRole(owner, key);
    const roles = (await api().get('/api/v1/roles').query({ limit: 100 }).set(bearer(owner)).expect(200)).body.data as Array<{ key: string; permissions: Array<{ resource: string; actions: string[] }> }>;
    const can = (role: string, resource: string, action: string) => roles.find((r) => r.key === role)!.permissions
      .some((p) => (p.resource === '*' || p.resource === resource) && (p.actions.includes('*') || p.actions.includes(action)));
    for (const def of masters.filter((m) => m.key !== 'custom-records')) {
      const base = `/api/v1/${def.key}`;
      const sample = (await api().get(base).query({ limit: 1 }).set(bearer(owner)).expect(200)).body.data[0];
      for (const [role, session] of Object.entries(sessions)) {
        const expect = (action: string, allowed: number) => (can(role, def.key, action) ? allowed : 403);
        const read = await api().get(base).query({ limit: 1 }).set(bearer(session));
        assert.equal(read.status, expect('read', 200), `${role} read ${def.key}`);
        if (!def.managed.create) assert.equal((await api().post(base).set(bearer(session)).send({})).status, expect('create', 422), `${role} create ${def.key}`);
        if (sample && !def.managed.update) assert.equal((await api().patch(`${base}/${sample.id}`).set(bearer(session)).send({ version: -1 })).status, expect('update', 422), `${role} update ${def.key}`);
        if (!def.managed.archive) assert.equal((await api().post(`${base}/${MISSING_ID}/archive`).set(bearer(session)).send({})).status, expect('archive', 404), `${role} archive ${def.key}`);
        if (!def.managed.delete) assert.equal((await api().delete(`${base}/${MISSING_ID}`).set(bearer(session))).status, expect('delete', 404), `${role} delete ${def.key}`);
        for (const path of def.sensitive as string[]) {
          const rows = read.status === 200 ? read.body.data : [];
          const values = rows.flatMap((r: unknown) => path.split('.').reduce<unknown[]>((vals, k) => vals.flatMap((v) => (v && typeof v === 'object' ? ([] as unknown[]).concat((v as Record<string, unknown>)[k] ?? []) : [])), [r]))
            .filter((v: unknown): v is string => typeof v === 'string');
          for (const value of values) assert.equal(value.startsWith('••••'), !can(role, def.key, 'sensitive'), `${role} ${def.key}.${path}`);
        }
      }
    }
  });
});

describe('sensitive fields', () => {
  test('a role without "sensitive" cannot set, change or clear them, but can edit the rest', async () => {
    const ops = await userWithRole(owner, 'operations', 'Sensitive check');
    const found = (await api().get('/api/v1/drivers').query({ search: 'Joseph' }).set(bearer(owner)).expect(200)).body.data[0];
    const driver = (await api().patch(`/api/v1/drivers/${found.id}`).set(bearer(owner)).send({ version: found.version, religion: 'Christian' }).expect(200)).body.data;
    const country = driver.nationalId.countryId;
    const refused = async (body: Record<string, unknown>) => {
      const res = await api().patch(`/api/v1/drivers/${driver.id}`).set(bearer(ops)).send({ version: driver.version, ...body });
      assert.equal(res.status, 403, `${JSON.stringify(body)}: ${JSON.stringify(res.body)}`);
      assert.ok(res.body.error.details.sensitive.length);
    };
    await refused({ religion: '••••tian' });
    await refused({ religion: null });
    await refused({ nationalId: { countryId: country, number: '654321/10/1' } });
    await refused({ nationalId: null });
    await refused({ taxIds: null });
    const masked = (await api().get(`/api/v1/drivers/${driver.id}`).set(bearer(ops)).expect(200)).body.data;
    const props = Object.keys(masters.find((m) => m.key === 'drivers')!.createSchema.properties);
    const form = Object.fromEntries(props.filter((k) => masked[k] !== undefined).map((k) => [k, masked[k]]));
    // Request validation may reject the masked values first; either way nothing is written.
    const formSave = await api().patch(`/api/v1/drivers/${driver.id}`).set(bearer(ops)).send({ ...form, version: driver.version });
    assert.ok([403, 422].includes(formSave.status), `masked form saved: ${formSave.status}`);
    const edited = await api().patch(`/api/v1/drivers/${driver.id}`).set(bearer(ops)).send({ version: driver.version, landmark: 'Near the market' });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    const after = (await api().get(`/api/v1/drivers/${driver.id}`).set(bearer(owner)).expect(200)).body.data;
    assert.equal(after.nationalId.number, driver.nationalId.number, 'the real value is untouched');
    const created = await api().post('/api/v1/drivers').set(bearer(ops)).send({ firstName: 'New', lastName: 'Driver', phone: '+260970000001', religion: 'Any' });
    assert.equal(created.status, 403);
    const ok = await api().patch(`/api/v1/drivers/${driver.id}`).set(bearer(owner)).send({ version: edited.body.data.version, religion: 'Catholic' });
    assert.equal(ok.status, 200, 'a role holding "sensitive" may write it');
  });
});
