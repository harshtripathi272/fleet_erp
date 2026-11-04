import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { api, bearer, loadSample, signUp, startDatabase, stopDatabase, userWithRole, type Session } from './helpers.js';

/** The master of masters (#65): each company shapes every master's definition, and the whole app follows it. */
let owner: Session;
before(async () => {
  await startDatabase();
  owner = await signUp('Owner');
  await loadSample(owner);
});
after(stopDatabase);

const save = (master: string, body: unknown, who = owner) => api().put(`/api/v1/meta/layouts/${master}`).set(bearer(who)).send(body);
const meta = async (key: string) => ((await api().get('/api/v1/meta/masters').set(bearer(owner)).expect(200)).body.data as { key: string; label: string; fields: Record<string, any>[] }[]).find((m) => m.key === key)!;
const field = (m: { fields: Record<string, any>[] }, path: string) => m.fields.find((f) => f.path === path)!;
const newDriver = (extra: Record<string, unknown> = {}) => api().post('/api/v1/drivers').set(bearer(owner))
  .send({ firstName: 'Layout', lastName: `Test${Math.random().toString(36).slice(2, 7)}`, phone: `+2609${Math.floor(10_000_000 + Math.random() * 89_999_999)}`, ...extra });

describe('a company shapes its masters', () => {
  test('hiding a field takes it off the definition and the import template; stored values stay', async () => {
    const withReligion = (await newDriver({ religion: 'Christian' }).expect(201)).body.data;
    await save('drivers', { fields: [{ path: 'religion', hidden: true }] }).expect(200);
    assert.equal(field(await meta('drivers'), 'religion').companyHidden, true);
    const template = (await api().get('/api/v1/meta/import/drivers/template').set(bearer(owner)).expect(200)).text;
    assert.ok(!/Religion/.test(template), template);
    const again = (await api().get(`/api/v1/drivers/${withReligion.id}`).set(bearer(owner)).expect(200)).body.data;
    assert.equal(again.religion, 'Christian', 'hiding never deletes data');
  });

  test('a field the company makes required is refused by the API when missing, nested fields included', async () => {
    await save('drivers', { fields: [{ path: 'licence.expiryDate', required: true, label: 'Licence valid until' }] }).expect(200);
    const res = await newDriver().expect(422);
    assert.ok(JSON.stringify(res.body).includes('Licence valid until is required by the company'), JSON.stringify(res.body));
    await newDriver({ licence: { number: 'L-1', expiryDate: '2028-01-01' } }).expect(201);
    assert.equal(field(await meta('drivers'), 'licence.expiryDate').label, 'Licence valid until');
  });

  test('renaming, reordering and retiring choices; a retired choice is refused for new values only', async () => {
    await save('drivers', { fields: [], choices: [{ path: 'employmentType', values: [{ value: 'contract', label: 'Fixed-term contract', order: 0 }, { value: 'casual', retired: true }] }] }).expect(200);
    const f = field(await meta('drivers'), 'employmentType');
    assert.equal(f.enum[0], 'contract');
    assert.equal(f.choiceLabels.contract, 'Fixed-term contract');
    assert.deepEqual(f.retiredChoices, ['casual']);
    const res = await newDriver({ employmentType: 'casual' }).expect(422);
    assert.match(JSON.stringify(res.body), /no longer offered/);
    await newDriver({ employmentType: 'contract' }).expect(201);
  });

  test('the master itself can be renamed, and the import accepts both names', async () => {
    await save('drivers', { master: { label: 'Crew', singular: 'Crew member' }, fields: [{ path: 'firstName', label: 'Given name' }] }).expect(200);
    const m = await meta('drivers');
    assert.equal(m.label, 'Crew');
    const template = (await api().get('/api/v1/meta/import/drivers/template').set(bearer(owner)).expect(200)).text;
    assert.ok(template.includes('Given name *'), template);
    const old = (await api().post('/api/v1/meta/import/drivers').set(bearer(owner)).send({ dryRun: true, rows: [{ 'First name': 'Old', 'Last name': 'Header', Phone: '+260977000111' }] }).expect(200)).body.data;
    assert.equal(old.results[0].status, 'ready', JSON.stringify(old.results[0]));
  });

  test('what would break the app is refused: hiding a needed field, loosening it, retiring a choice the app acts on', async () => {
    const hide = await save('drivers', { fields: [{ path: 'phone', hidden: true }] }).expect(422);
    assert.match(JSON.stringify(hide.body), /can be renamed or moved but not hidden/);
    await save('drivers', { fields: [{ path: 'lastName', required: false }] }).expect(422);
    await save('drivers', { fields: [{ path: 'references.name', required: true }] }).expect(422);
    await save('drivers', { fields: [{ path: 'nosuchfield', label: 'X' }] }).expect(422);
    const locked = await save('approval-policies', { choices: [{ path: 'subject', values: [{ value: 'cash_advance', retired: true }] }] }).expect(422);
    assert.match(JSON.stringify(locked.body), /can be renamed but not retired/);
  });

  test('reset: saving without an entry restores the code default', async () => {
    await save('drivers', { master: {}, fields: [], choices: [] }).expect(200);
    const m = await meta('drivers');
    assert.equal(m.label, 'Drivers');
    assert.equal(field(m, 'religion').companyHidden, undefined);
    await newDriver().expect(201);
  });

  test('only someone who may change the company may reshape masters; every change is audited', async () => {
    const viewer = await userWithRole(owner, 'viewer');
    await save('drivers', { fields: [{ path: 'religion', hidden: true }] }, viewer).expect(403);
    const log = (await api().get('/api/v1/audit-logs').query({ entity: 'record-layouts' }).set(bearer(owner)).expect(200)).body.data;
    assert.ok(log.length >= 4, `audited: ${log.length}`);
  });
});
