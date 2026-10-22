import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { api, bearer, errorCode, find, loadSample, resetDatabase, signUp, startDatabase, stopDatabase, userWithRole, type Session } from './helpers.js';

before(startDatabase);
after(stopDatabase);

let owner: Session;
beforeEach(async () => {
  await resetDatabase();
  owner = await signUp('Owner');
  await loadSample(owner);
});

describe('signed-out access', () => {
  test('the models reference is readable without signing in and carries no records or permissions', async () => {
    const r = await api().get('/api/v1/meta/models').expect(200);
    const vehicles = r.body.data.find((m: { key: string }) => m.key === 'vehicles');
    assert.ok(vehicles.fields.some((f: { path: string }) => f.path === 'registrationNumber'));
    assert.equal(vehicles.permissions, undefined);
    assert.equal(JSON.stringify(r.body).includes('ALC 4821'), false);
    await api().get('/api/v1/meta/masters').expect(401);
    await api().get('/api/v1/meta/stats').expect(401);
    await api().get('/api/v1/vehicles').expect(401);
  });
});

describe('role permissions', () => {
  test('viewer reads everything but cannot change anything', async () => {
    const viewer = await userWithRole(owner, 'viewer');
    await api().get('/api/v1/vehicles').set(bearer(viewer)).expect(200);
    await api().get('/api/v1/audit-logs').set(bearer(viewer)).expect(200);
    const denied = await api().post('/api/v1/currencies').set(bearer(viewer)).send({ code: 'EUR', name: 'Euro' }).expect(403);
    assert.equal(errorCode(denied), 'FORBIDDEN');
    const country = await find(owner, 'countries', 'ZM');
    await api().patch(`/api/v1/countries/${country.id}`).set(bearer(viewer)).send({ version: country.version, name: 'X' }).expect(403);
    await api().post(`/api/v1/countries/${country.id}/archive`).set(bearer(viewer)).expect(403);
    await api().delete(`/api/v1/countries/${country.id}`).set(bearer(viewer)).expect(403);
    await api().put('/api/v1/company').set(bearer(viewer)).send({ legalName: 'X' }).expect(403);
    await api().post('/api/v1/meta/sample-data').set(bearer(viewer)).expect(403);
  });

  test('operations maintains fleet and places but not money or users', async () => {
    const ops = await userWithRole(owner, 'operations');
    await api().post('/api/v1/vehicle-makes').set(bearer(ops)).send({ code: 'MAN', name: 'MAN' }).expect(201);
    await api().post('/api/v1/places').set(bearer(ops)).send({ code: 'NEW-SITE', name: 'New site', type: 'customer_site' }).expect(201);
    await api().post('/api/v1/currencies').set(bearer(ops)).send({ code: 'EUR', name: 'Euro' }).expect(403);
    await api().post('/api/v1/users').set(bearer(ops)).send({ name: 'X', email: 'x@example.test', roleIds: [] }).expect(403);
    const make = await find(owner, 'vehicle-makes', 'MAN');
    await api().delete(`/api/v1/vehicle-makes/${make.id}`).set(bearer(ops)).expect(403);
  });

  test('finance maintains money and sees sensitive values; others see them masked', async () => {
    const finance = await userWithRole(owner, 'finance');
    const viewer = await userWithRole(owner, 'viewer');
    await api().post('/api/v1/currencies').set(bearer(finance)).send({ code: 'EUR', name: 'Euro' }).expect(201);
    await api().post('/api/v1/vehicle-makes').set(bearer(finance)).send({ code: 'DAF', name: 'DAF' }).expect(403);
    const asFinance = await api().get('/api/v1/drivers').query({ search: 'Mwansa' }).set(bearer(finance)).expect(200);
    const asViewer = await api().get('/api/v1/drivers').query({ search: 'Mwansa' }).set(bearer(viewer)).expect(200);
    assert.equal(asFinance.body.data[0].nationalId.number, '123456/10/1');
    assert.equal(asViewer.body.data[0].nationalId.number, '••••10/1');
    assert.equal(asViewer.body.data[0].payout.accountNumber, '••••4567');
    assert.equal(asViewer.body.data[0].taxIds.tpin, '••••7890');
    const party = await api().get('/api/v1/parties').query({ search: 'Leasing' }).set(bearer(viewer)).expect(200);
    assert.equal(party.body.data[0].bankAccounts[0].accountNumber, '••••9012');
    const one = await api().get(`/api/v1/drivers/${asViewer.body.data[0].id}`).set(bearer(viewer)).expect(200);
    assert.equal(one.body.data.nationalId.number, '••••10/1');
  });

  test('custom roles grant exactly what they list', async () => {
    const role = await api().post('/api/v1/roles').set(bearer(owner)).send({ key: 'fuel-desk', name: 'Fuel desk', permissions: [{ resource: 'fuel-types', actions: ['read', 'create'] }] }).expect(201);
    const email = `fuel.${Date.now()}@example.test`;
    await api().post('/api/v1/users').set(bearer(owner)).send({ name: 'Fuel desk', email, password: 'Passw0rd!', roleIds: [role.body.data.id] }).expect(201);
    const login = await api().post('/api/v1/auth/login').send({ email, password: 'Passw0rd!' }).expect(200);
    const s = { token: login.body.data.accessToken };
    const unit = await find(owner, 'units', 'Litre');
    await api().post('/api/v1/fuel-types').set(bearer(s)).send({ code: 'PETROL', name: 'Petrol', unitId: unit.id }).expect(201);
    await api().get('/api/v1/vehicles').set(bearer(s)).expect(403);
    await api().get('/api/v1/meta/masters').set(bearer(s)).expect(200);
    // Removing the permission takes effect on the next request.
    const r = await api().get(`/api/v1/roles/${role.body.data.id}`).set(bearer(owner));
    await api().patch(`/api/v1/roles/${role.body.data.id}`).set(bearer(owner)).send({ version: r.body.data.version, permissions: [{ resource: 'fuel-types', actions: ['read'] }] }).expect(200);
    await api().post('/api/v1/fuel-types').set(bearer(s)).send({ code: 'AGO', name: 'AGO', unitId: unit.id }).expect(403);
  });

  test('roles reject unknown resources, duplicate resources and edits to built-in roles', async () => {
    const bad = await api().post('/api/v1/roles').set(bearer(owner)).send({ key: 'bad', name: 'Bad', permissions: [{ resource: 'spaceships', actions: ['read'] }] }).expect(422);
    assert.ok(JSON.stringify(bad.body).includes('spaceships'));
    await api().post('/api/v1/roles').set(bearer(owner)).send({ key: 'dup', name: 'Dup', permissions: [{ resource: 'vehicles', actions: ['read'] }, { resource: 'vehicles', actions: ['create'] }] }).expect(422);
    await api().post('/api/v1/roles').set(bearer(owner)).send({ key: 'bad2', name: 'Bad', permissions: [{ resource: 'vehicles', actions: ['fly'] }] }).expect(422);
    const ownerRole = await find(owner, 'roles', 'owner');
    await api().patch(`/api/v1/roles/${ownerRole.id}`).set(bearer(owner)).send({ version: ownerRole.version, name: 'Boss' }).expect(409);
    await api().post(`/api/v1/roles/${ownerRole.id}/archive`).set(bearer(owner)).expect(409);
    await api().delete(`/api/v1/roles/${ownerRole.id}`).set(bearer(owner)).expect(409);
    await api().post('/api/v1/roles').set(bearer(owner)).send({ key: 'owner', name: 'Second owner', permissions: [] }).expect(409);
  });
});

describe('privilege escalation', () => {
  test('a user manager cannot hand out roles or permissions beyond their own', async () => {
    const hr = await api().post('/api/v1/roles').set(bearer(owner)).send({ key: 'hr', name: 'HR', permissions: [{ resource: 'users', actions: ['read', 'create', 'update'] }, { resource: 'roles', actions: ['read', 'create', 'update'] }] }).expect(201);
    const email = `hr.${Date.now()}@example.test`;
    await api().post('/api/v1/users').set(bearer(owner)).send({ name: 'HR person', email, password: 'Passw0rd!', roleIds: [hr.body.data.id] }).expect(201);
    const s = { token: (await api().post('/api/v1/auth/login').send({ email, password: 'Passw0rd!' })).body.data.accessToken };
    const me = (await api().get('/api/v1/auth/me').set(bearer(s))).body.data.user;
    const ownerRole = await find(owner, 'roles', 'owner');
    const adminRole = await find(owner, 'roles', 'admin');
    const viewerRole = await find(owner, 'roles', 'viewer');
    await api().patch(`/api/v1/users/${me.id}`).set(bearer(s)).send({ version: me.version, roleIds: [hr.body.data.id, ownerRole.id] }).expect(403);
    await api().patch(`/api/v1/users/${me.id}`).set(bearer(s)).send({ version: me.version, roleIds: [hr.body.data.id, adminRole.id] }).expect(403);
    await api().post('/api/v1/users').set(bearer(s)).send({ name: 'Puppet', email: `p.${Date.now()}@example.test`, password: 'Passw0rd!', roleIds: [adminRole.id] }).expect(403);
    await api().post('/api/v1/roles').set(bearer(s)).send({ key: 'god', name: 'God', permissions: [{ resource: '*', actions: ['*'] }] }).expect(403);
    await api().post('/api/v1/roles').set(bearer(s)).send({ key: 'cash', name: 'Cash', permissions: [{ resource: 'currencies', actions: ['create'] }] }).expect(403);
    const hrRole = (await api().get(`/api/v1/roles/${hr.body.data.id}`).set(bearer(s))).body.data;
    await api().patch(`/api/v1/roles/${hr.body.data.id}`).set(bearer(s)).send({ version: hrRole.version, permissions: [{ resource: '*', actions: ['*'] }] }).expect(403);
    // Within their own permissions they can still work.
    await api().post('/api/v1/roles').set(bearer(s)).send({ key: 'user-reader', name: 'User reader', permissions: [{ resource: 'users', actions: ['read'] }] }).expect(201);
    await api().post('/api/v1/users').set(bearer(s)).send({ name: 'Plain', email: `plain.${Date.now()}@example.test`, password: 'Passw0rd!', roleIds: [] }).expect(201);
    // Viewer grants read on '*', which HR does not hold.
    await api().post('/api/v1/users').set(bearer(s)).send({ name: 'Viewer', email: `v.${Date.now()}@example.test`, password: 'Passw0rd!', roleIds: [viewerRole.id] }).expect(403);
  });

  test('only an owner can remove the Owner role from someone', async () => {
    const admin = await userWithRole(owner, 'admin');
    const second = await userWithRole(owner, 'owner', 'Second owner');
    const target = (await api().get(`/api/v1/users/${second.userId}`).set(bearer(admin))).body.data;
    const viewerRole = await find(owner, 'roles', 'viewer');
    await api().patch(`/api/v1/users/${second.userId}`).set(bearer(admin)).send({ version: target.version, roleIds: [viewerRole.id] }).expect(403);
    await api().patch(`/api/v1/users/${second.userId}`).set(bearer(owner)).send({ version: target.version, roleIds: [viewerRole.id] }).expect(200);
  });
});

describe('cross-origin requests', () => {
  test('only configured origins receive CORS headers', async () => {
    const { env } = await import('../src/config/env.js');
    env.CORS_ORIGINS = ['http://localhost:5173'];
    const ok = await api().options('/api/v1/vehicles').set('Origin', 'http://localhost:5173').expect(204);
    assert.equal(ok.headers['access-control-allow-origin'], 'http://localhost:5173');
    const other = await api().get('/api/v1/health').set('Origin', 'https://evil.example');
    assert.equal(other.headers['access-control-allow-origin'], undefined);
    env.CORS_ORIGINS = [];
  });
});

describe('owner protections', () => {
  test('the last active owner cannot be removed, deactivated or archived', async () => {
    const me = await api().get(`/api/v1/users/${owner.userId}`).set(bearer(owner)).expect(200);
    const viewerRole = await find(owner, 'roles', 'viewer');
    const demote = await api().patch(`/api/v1/users/${owner.userId}`).set(bearer(owner)).send({ version: me.body.data.version, roleIds: [viewerRole.id] }).expect(409);
    assert.match(demote.body.error.message, /owner/);
    await api().patch(`/api/v1/users/${owner.userId}`).set(bearer(owner)).send({ version: me.body.data.version, status: 'inactive' }).expect(409);
    await api().post(`/api/v1/users/${owner.userId}/archive`).set(bearer(owner)).expect(409);
    await api().delete(`/api/v1/users/${owner.userId}`).set(bearer(owner)).expect(404);
  });

  test('a second owner can demote the first', async () => {
    const ownerRole = await find(owner, 'roles', 'owner');
    const viewerRole = await find(owner, 'roles', 'viewer');
    const second = await userWithRole(owner, 'owner', 'Second owner');
    const me = await api().get(`/api/v1/users/${owner.userId}`).set(bearer(second)).expect(200);
    await api().patch(`/api/v1/users/${owner.userId}`).set(bearer(second)).send({ version: me.body.data.version, roleIds: [viewerRole.id] }).expect(200);
    const remaining = await api().get('/api/v1/users').set(bearer(second)).expect(200);
    assert.equal(remaining.body.data.filter((u: { roleIds: string[] }) => u.roleIds.includes(ownerRole.id)).length, 1);
  });

  test('admins cannot lock themselves out', async () => {
    const admin = await userWithRole(owner, 'admin');
    const self = await api().get(`/api/v1/users/${admin.userId}`).set(bearer(admin)).expect(200);
    await api().patch(`/api/v1/users/${admin.userId}`).set(bearer(admin)).send({ version: self.body.data.version, status: 'inactive' }).expect(409);
    await api().post(`/api/v1/users/${admin.userId}/archive`).set(bearer(admin)).expect(409);
  });

  test('users never expose password hashes or token versions', async () => {
    const list = await api().get('/api/v1/users').set(bearer(owner)).expect(200);
    for (const u of list.body.data) {
      assert.equal(u.passwordHash, undefined);
      assert.equal(u.tokenVersion, undefined);
      assert.equal(u.failedLoginCount, undefined);
    }
    await api().get('/api/v1/users').query({ sort: 'passwordHash' }).set(bearer(owner)).expect(422);
  });
});
