// #68, phase 3 of docs/entities.md: custom masters as record types like the built-in ones, references to any
// record type, who may see or change each field by role, and list views saved per role.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { clearLayoutCache } from '../src/core/masters/layout.js';
import { api, bearer, find, loadSample, resetDatabase, signUp, startDatabase, stopDatabase, userWithRole, type Session } from './helpers.js';

let owner: Session, ops: Session, fin: Session;
const ids: Record<string, string> = {};
const as = (s: { token: string }) => ({
  get: (path: string) => api().get(`/api/v1${path}`).set(bearer(s)),
  post: (path: string, body: unknown = {}) => api().post(`/api/v1${path}`).set(bearer(s)).send(body as object),
  put: (path: string, body: unknown) => api().put(`/api/v1${path}`).set(bearer(s)).send(body as object),
  patch: (path: string, body: unknown) => api().patch(`/api/v1${path}`).set(bearer(s)).send(body as object),
});
const ok = <T = any>(res: { status: number; body: any }, status = 200): T => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body.data as T;
};
const layout = async (master: string, body: unknown) => { const r = await as(owner).put(`/meta/layouts/${master}`, body); clearLayoutCache(); return r; };
const metaOf = async (s: Session, key: string) => (ok<any[]>(await as(s).get('/meta/masters'))).find((m) => m.key === key);

before(startDatabase);
after(stopDatabase);
beforeEach(async () => {
  await resetDatabase();
  clearLayoutCache();
  owner = await signUp('Owner');
  await loadSample(owner);
  ops = await userWithRole(owner, 'operations', 'Olivia Ops');
  fin = await userWithRole(owner, 'finance', 'Felix Finance');
  ids.d1 = (await find(owner, 'drivers', 'Joseph')).id;
  ids.v1 = (await find(owner, 'vehicles', 'ALC 4821')).id;
  ids.health = (await find(owner, 'custom-masters', 'health-cards')).id;
});

describe('who may see and change each field', () => {
  test('a field only Finance sees, and one only an administrator changes', async () => {
    ok(await layout('drivers', { fields: [{ path: 'bloodGroup', seeRoles: ['finance'], editRoles: ['finance'] }, { path: 'notes', editRoles: ['admin'] }, { path: 'custom.union', seeRoles: ['finance'] }] }));

    const seen = ok(await as(ops).get(`/drivers/${ids.d1}`));
    assert.equal(seen.bloodGroup, undefined, 'Operations does not see it');
    assert.equal(seen.custom?.union, undefined, 'nor the company field');
    assert.equal(ok(await as(fin).get(`/drivers/${ids.d1}`)).bloodGroup, 'O+', 'Finance does');
    assert.equal(ok(await as(owner).get(`/drivers/${ids.d1}`)).bloodGroup, 'O+', 'an owner always does');
    assert.ok(!ok(await as(ops).get('/drivers?search=Joseph')).find((d: any) => d.bloodGroup), 'nor in the list');

    const meta = await metaOf(ops, 'drivers');
    assert.ok(!meta.fields.some((f: any) => f.path === 'bloodGroup'), 'its form leaves it out');
    assert.equal(meta.fields.find((f: any) => f.path === 'notes').readOnly, true, 'and shows notes read-only');
    assert.ok(!meta.customFields.some((f: any) => f.key === 'union'));

    const driver = ok(await as(ops).get(`/drivers/${ids.d1}`));
    const refused = await as(ops).patch(`/drivers/${ids.d1}`, { notes: 'Changed by Operations', version: driver.version });
    assert.equal(refused.status, 403);
    assert.deepEqual(refused.body.error.details, { fields: ['notes'] });
    const allowed = ok(await as(ops).patch(`/drivers/${ids.d1}`, { lastName: 'Mwansa-Banda', version: driver.version }));
    assert.equal(allowed.lastName, 'Mwansa-Banda');
    assert.equal(ok(await as(fin).get(`/drivers/${ids.d1}`)).bloodGroup, 'O+', 'what Operations could not see is kept');
    ok(await as(owner).patch(`/drivers/${ids.d1}`, { notes: 'Changed by the owner', version: allowed.version }));
  });

  test('the rules are checked when they are saved', async () => {
    const r1 = await layout('drivers', { fields: [{ path: 'bloodGroup', seeRoles: ['finance'], editRoles: ['operations'] }] });
    assert.equal(r1.status, 422, 'a role that may change a field must see it');
    const r2 = await layout('drivers', { fields: [{ path: 'bloodGroup', seeRoles: ['accountants'] }] });
    assert.equal(r2.status, 422);
    assert.deepEqual(r2.body.error.details, { roles: ['No role "accountants"'] });
    const r3 = await layout('drivers', { fields: [{ path: 'firstName', seeRoles: ['finance'] }] });
    assert.equal(r3.status, 422, 'the app needs it, so everyone working with drivers sees it');
  });
});

describe('list views saved per role', () => {
  test('each role is offered its own views and the shared ones, default first', async () => {
    ok(await layout('drivers', { views: [
      { key: 'licences', name: 'Licences due', roles: ['operations'], columns: ['name', 'licence.expiryDate'], sort: 'licence.expiryDate', filters: { licenceExpiringWithinDays: '60' } },
      { key: 'all', name: 'Everyone', isDefault: true },
    ] }));
    assert.deepEqual((await metaOf(ops, 'drivers')).views.map((v: any) => v.key), ['all', 'licences']);
    assert.deepEqual((await metaOf(fin, 'drivers')).views.map((v: any) => v.key), ['all']);
    const view = (await metaOf(ops, 'drivers')).views.find((v: any) => v.key === 'licences');
    assert.deepEqual([view.columns, view.sort, view.filters], [['name', 'licence.expiryDate'], 'licence.expiryDate', { licenceExpiringWithinDays: '60' }]);

    const bad = await layout('drivers', { views: [{ key: 'x', name: 'X', columns: ['nope'], sort: 'bloodGroup', filters: { colour: 'red' } }] });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.error.details['views.x'].length, 3, 'unknown column, sort and filter');
  });
});

describe('references to any record type', () => {
  test('a company field can point at a custom master\'s records, or a trip', async () => {
    const types = ok<any[]>(await as(owner).get('/meta/record-types'));
    const kinds = (k: string) => types.filter((t) => t.kind === k).map((t) => t.key);
    assert.ok(kinds('master').includes('drivers'));
    assert.ok(kinds('record').includes('trips') && kinds('record').includes('invoices'));
    assert.deepEqual(kinds('custom'), [`custom-${ids.health}`]);

    ok(await as(owner).post('/field-definitions', { entity: 'vehicles', key: 'healthCard', label: 'Driver health card', type: 'reference', referenceMaster: `custom-${ids.health}` }), 201);
    ok(await as(owner).post('/field-definitions', { entity: 'vehicles', key: 'lastTrip', label: 'Last trip', type: 'reference', referenceMaster: 'trips' }), 201);
    const bad = await as(owner).post('/field-definitions', { entity: 'vehicles', key: 'nowhere', label: 'Nowhere', type: 'reference', referenceMaster: 'not-a-type' });
    assert.equal(bad.status, 422);

    const cards = ok<any[]>(await as(ops).get(`/meta/references/custom-${ids.health}?search=hc-0`));
    assert.deepEqual(cards.map((c) => c.title), ['HC-001']);
    const vehicle = ok(await as(owner).get(`/vehicles/${ids.v1}`));
    const linked = ok(await as(owner).patch(`/vehicles/${ids.v1}`, { custom: { healthCard: cards[0].id }, version: vehicle.version }));
    assert.equal(linked.custom.healthCard, cards[0].id);
    const wrong = await as(owner).patch(`/vehicles/${ids.v1}`, { custom: { healthCard: ids.d1 }, version: linked.version });
    assert.equal(wrong.status, 422, 'a driver is not a health card');
    assert.deepEqual(ok(await as(ops).get(`/meta/references/custom-${ids.health}?ids=${cards[0].id}`)).map((c: any) => c.title), ['HC-001']);
    assert.equal((await as(ops).get('/meta/references/not-a-type')).status, 404);
  });
});

describe('custom masters as record types', () => {
  test('a custom master is described like a built-in one and shaped the same way', async () => {
    const key = `custom-${ids.health}`;
    const described = await metaOf(owner, key);
    assert.equal(described.kind, 'custom');
    assert.equal(described.label, 'Health cards');
    assert.deepEqual(described.fields.map((f: any) => f.path), ['data.cardNumber', 'data.driver', 'data.clinic', 'data.expiryDate']);
    assert.equal(described.fields.find((f: any) => f.path === 'data.driver').ref, 'drivers');

    ok(await layout(key, { master: { label: 'Medical cards' }, fields: [{ path: 'data.clinic', label: 'Issuing clinic', seeRoles: ['finance'] }] }));
    assert.equal((await metaOf(owner, key)).label, 'Medical cards');
    assert.equal((await metaOf(fin, key)).fields.find((f: any) => f.path === 'data.clinic').label, 'Issuing clinic');
    assert.ok(!(await metaOf(ops, key)).fields.some((f: any) => f.path === 'data.clinic'));
    const [record] = ok<any[]>(await as(ops).get(`/custom-masters/${ids.health}/records`));
    assert.equal(record.data.clinic, undefined, 'Operations does not see it on the record either');
    assert.equal(ok<any[]>(await as(fin).get(`/custom-masters/${ids.health}/records`))[0].data.clinic, 'Lusaka Medical Centre');
    assert.equal((await layout(key, { fields: [{ path: 'data.nope', label: 'No' }] })).status, 422);
  });
});
