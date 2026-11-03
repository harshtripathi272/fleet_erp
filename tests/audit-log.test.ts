import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Types } from 'mongoose';
import { AuditLog } from '../src/core/masters/audit.model.js';
import { api, bearer, find, loadSample, resetDatabase, signUp, startDatabase, stopDatabase, userWithRole, type Session } from './helpers.js';

/** The audit log screen's API (#36): the whole company's changes, with names, titles and masked values. */
let owner: Session, viewer: Session;

const get = (s: Session, path: string, query: Record<string, unknown> = {}) => api().get(`/api/v1${path}`).query(query).set(bearer(s));
const ok = <T = any>(res: { status: number; body: any }, status = 200): T => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body.data as T;
};

before(startDatabase);
after(stopDatabase);
beforeEach(async () => {
  await resetDatabase();
  owner = await signUp('Olga Owner');
  await loadSample(owner);
  viewer = await userWithRole(owner, 'viewer', 'Vera Viewer');
});

describe('the audit log', () => {
  test('each entry names the person, the master and the record, newest first', async () => {
    const driver = await find(owner, 'drivers', 'Joseph');
    ok(await api().patch(`/api/v1/drivers/${driver.id}`).set(bearer(owner)).send({ version: driver.version, notes: 'Prefers the Dar route' }));
    const entries = ok<any[]>(await get(viewer, '/audit-logs', { entity: 'drivers', limit: 5 }));
    const latest = entries[0];
    assert.equal(latest.action, 'update');
    assert.equal(latest.actorName, 'Olga Owner');
    assert.equal(latest.entityLabel, 'Driver');
    assert.equal(latest.title, driver.name);
    assert.equal(latest.openable, true);
    assert.deepEqual(latest.changes.map((c: { path: string }) => c.path), ['notes']);
    assert.ok(entries.every((e, i) => i === 0 || entries[i - 1].at >= e.at), 'newest first');
  });

  test('a deleted record keeps the title it had', async () => {
    const created = ok(await api().post('/api/v1/order-sources').set(bearer(owner)).send({ code: 'FAIR', name: 'Trade fair' }), 201);
    await api().delete(`/api/v1/order-sources/${created.id}`).set(bearer(owner)).send({ version: created.version }).expect(204);
    const entries = ok<any[]>(await get(owner, '/audit-logs', { entityId: created.id }));
    assert.deepEqual(entries.map((e) => e.action), ['delete', 'create']);
    assert.ok(entries.every((e) => e.title === 'Trade fair'), JSON.stringify(entries.map((e) => e.title)));
    assert.equal(entries[0].openable, false, 'a deleted record has nothing to open');
  });

  test('sensitive values are masked for people without the sensitive permission, in the list and the CSV', async () => {
    const driver = await find(owner, 'drivers', 'Joseph');
    // The master service never writes them...
    ok(await api().patch(`/api/v1/drivers/${driver.id}`).set(bearer(owner)).send({ version: driver.version, religion: 'Catholic' }));
    const written = ok<any[]>(await get(owner, '/audit-logs', { entity: 'drivers', limit: 1 }))[0];
    assert.deepEqual(written.changes, [{ path: 'religion', from: '[hidden]', to: '[hidden]' }]);
    // ...and an entry from another writer, or an older one, is masked when read.
    await AuditLog.create({ entity: 'drivers', entityId: new Types.ObjectId(driver.id), action: 'update', changes: [{ path: 'payout', from: { accountNumber: '0012345678' }, to: { accountNumber: '0099999999' } }, { path: 'phone', from: '+260900000000', to: '+260911111111' }], at: new Date(Date.now() + 1000) });
    const forViewer = ok<any[]>(await get(viewer, '/audit-logs', { entity: 'drivers', limit: 1 }))[0];
    assert.deepEqual(forViewer.changes, [{ path: 'payout', from: '[hidden]', to: '[hidden]' }, { path: 'phone', from: '+260900000000', to: '+260911111111' }]);
    const forOwner = ok<any[]>(await get(owner, '/audit-logs', { entity: 'drivers', limit: 1 }))[0];
    assert.deepEqual(forOwner.changes[0].to, { accountNumber: '0099999999' }, 'the owner holds the sensitive permission');
    const csv = (await get(viewer, '/audit-logs/export', { entity: 'drivers' }).expect(200)).text;
    assert.ok(!csv.includes('0099999999') && csv.includes('[hidden]'), 'masked in the CSV too');
    assert.ok((await get(owner, '/audit-logs/export', { entity: 'drivers' })).text.includes('0099999999'));
  });

  test('filters by person, action and dates; lists the people and masters in the log', async () => {
    const other = await userWithRole(owner, 'operations', 'Olivia Ops');
    ok(await api().post('/api/v1/order-sources').set(bearer(other)).send({ code: 'RADIO', name: 'Radio advert' }), 201);
    const people = ok<any[]>(await get(viewer, '/audit-logs/people'));
    assert.ok(people.some((p) => p.id === other.userId && p.name === 'Olivia Ops'));
    const mine = ok<any[]>(await get(viewer, '/audit-logs', { actorId: other.userId }));
    assert.ok(mine.length >= 1 && mine.every((e) => e.actorName === 'Olivia Ops'));
    const created = ok<any[]>(await get(viewer, '/audit-logs', { actorId: other.userId, action: 'create', entity: 'order-sources' }));
    assert.deepEqual(created.map((e) => e.title), ['Radio advert']);
    const today = new Date().toISOString().slice(0, 10);
    assert.ok(ok<any[]>(await get(viewer, '/audit-logs', { from: today, to: today, actorId: other.userId })).length >= 1, 'a day range includes the whole day');
    assert.equal(ok<any[]>(await get(viewer, '/audit-logs', { to: '2000-01-01' })).length, 0);
    const entities = ok<any[]>(await get(viewer, '/audit-logs/entities'));
    assert.ok(entities.some((e) => e.key === 'order-sources' && e.label === 'Order sources'));
  });

  test('the CSV has one row per changed field, quoted against spreadsheet formulas', async () => {
    ok(await api().post('/api/v1/order-sources').set(bearer(owner)).send({ code: 'EQ', name: '=HYPERLINK("x")' }), 201);
    const res = await get(owner, '/audit-logs/export', { entity: 'order-sources', action: 'create' }).expect(200);
    assert.match(String(res.headers['content-type']), /text\/csv/);
    assert.match(String(res.headers['content-disposition']), /attachment; filename="audit-log-/);
    const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
    assert.equal(lines[0], '"When","Who","Master","Record","Action","Summary","Field","Before","After"');
    assert.ok(lines.some((l) => l.includes(`"'=HYPERLINK(""x"")"`)), 'a formula is turned into text');
    assert.ok(lines.slice(1).every((l) => l.includes('"Olga Owner"')));
  });

  test('a role without audit-logs:read gets no log', async () => {
    const role = ok(await api().post('/api/v1/roles').set(bearer(owner)).send({ key: 'driver-clerk', name: 'Driver clerk', permissions: [{ resource: 'drivers', actions: ['read'] }] }), 201);
    const email = `clerk-${Date.now()}@example.test`;
    ok(await api().post('/api/v1/users').set(bearer(owner)).send({ name: 'Cleo Clerk', email, password: 'Passw0rd!', roleIds: [role.id] }), 201);
    const clerk = { token: ok<{ accessToken: string }>(await api().post('/api/v1/auth/login').send({ email, password: 'Passw0rd!' })).accessToken } as Session;
    for (const path of ['/audit-logs', '/audit-logs/people', '/audit-logs/entities', '/audit-logs/export']) await get(clerk, path).expect(403);
  });
});
