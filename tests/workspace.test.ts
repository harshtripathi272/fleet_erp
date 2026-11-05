import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { word } from '../src/modules/company/workspace.js';
import { api, bearer, loadSample, signUp, startDatabase, stopDatabase, userWithRole, type Session } from './helpers.js';

/** The company's own words, trip stages and desks (#73). */
let owner: Session;
before(async () => {
  await startDatabase();
  owner = await signUp('Owner');
  await loadSample(owner);
});
after(stopDatabase);

type Ws = {
  words: Record<string, { singular: string; plural: string }>;
  stages: { key: string; name: string; on: boolean; optional: boolean; switchedOff: boolean; areaOff: boolean }[];
  desks: { key: string; name: string; views: string[]; kind: string; actsAs: string }[];
  deskSetup: { key: string; views: string[] }[];
};
const workspace = async (who = owner) => (await api().get('/api/v1/meta/workspace').set(bearer(who)).expect(200)).body.data as Ws;
const save = async (changes: Record<string, unknown>, status = 200) => {
  const company = (await api().get('/api/v1/company').set(bearer(owner)).expect(200)).body.data;
  return api().put('/api/v1/company').set(bearer(owner)).send({ ...changes, version: company.version }).expect(status);
};
const ALL = ['masters', 'trips', 'finance', 'tracking', 'driver-app'];

describe('words, stages and desks', () => {
  test('a company that changed nothing gets the defaults', async () => {
    const ws = await workspace();
    assert.deepEqual(ws.words.trip, { singular: 'Trip', plural: 'Trips' });
    assert.deepEqual(ws.stages.map((s) => s.key), ['plan', 'funding', 'loading', 'transit', 'offloading', 'close', 'settle']);
    assert.ok(ws.stages.every((s) => s.on));
    assert.deepEqual(ws.desks.map((d) => d.key), ['owner', 'operations', 'finance']);
  });

  test('its own words reach the screens and the documents; only the changes are stored', async () => {
    await save({ vocabulary: { trip: { singular: 'Load', plural: 'Loads' } } });
    const ws = await workspace();
    assert.deepEqual(ws.words.trip, { singular: 'Load', plural: 'Loads' });
    assert.deepEqual(ws.words.driver, { singular: 'Driver', plural: 'Drivers' }, 'an untouched term keeps its default');
    assert.equal(await word('trip', true), 'Loads');
    const company = (await api().get('/api/v1/company').set(bearer(owner)).expect(200)).body.data;
    assert.deepEqual(Object.keys(company.vocabulary), ['trip']);
    await save({ vocabulary: {} });
    assert.equal(await word('trip'), 'Trip');
  });

  test('a word needs both forms, and an unknown term is refused', async () => {
    await save({ vocabulary: { trip: { singular: 'Load' } } }, 422);
    await save({ vocabulary: { wagon: { singular: 'Wagon', plural: 'Wagons' } } }, 422);
  });

  test('stages are renamed, funding and settlement can be off, and the others cannot', async () => {
    await save({ stages: { transit: { name: 'On the road' }, funding: { off: true } } });
    const ws = await workspace();
    const by = (k: string) => ws.stages.find((s) => s.key === k)!;
    assert.equal(by('transit').name, 'On the road');
    assert.equal(by('funding').on, false);
    assert.equal(by('funding').switchedOff, true);
    await save({ stages: { loading: { off: true } } });
    assert.equal((await workspace()).stages.find((s) => s.key === 'loading')!.on, true, 'a stage every trip has stays on');
    await save({ stages: {} });
  });

  test('with Money off, funding and settlement are off and its screens leave the desks, without losing the company choice', async () => {
    await save({ modules: ['masters', 'trips', 'tracking', 'driver-app'] });
    const ws = await workspace();
    const funding = ws.stages.find((s) => s.key === 'funding')!;
    assert.equal(funding.on, false);
    assert.equal(funding.areaOff, true);
    assert.ok(!ws.desks.some((d) => d.views.includes('accounts')), 'driver accounts belong to Money');
    assert.ok(!ws.desks.some((d) => d.key === 'finance' && d.views.includes('today')));
    assert.ok(ws.deskSetup.find((d) => d.key === 'owner')!.views.includes('accounts'), 'the setup keeps the screen for when Money is back');
    await save({ modules: ALL });
  });

  test('a company adds a desk for named roles that works like a built-in one', async () => {
    const desks = [
      { key: 'owner', name: 'Head office', icon: 'gauge', views: ['overview', 'trips', 'masters'], kind: 'owner' },
      { key: 'workshop', name: 'Workshop', icon: 'wrench', views: ['trips', 'masters'], kind: 'roles', roleKeys: ['workshop'], actsAs: 'operations' },
    ];
    await save({ desks });
    const ws = await workspace();
    assert.deepEqual(ws.desks.map((d) => [d.key, d.name, d.actsAs]), [['owner', 'Head office', 'owner'], ['workshop', 'Workshop', 'operations']]);
    await save({ desks: [] });
    assert.deepEqual((await workspace()).desks.map((d) => d.key), ['owner', 'operations', 'finance'], 'an empty list brings back the defaults');
  });

  test('desks are checked: unique keys, known screens and icons, at least one screen', async () => {
    const desk = { key: 'yard', name: 'Yard', icon: 'truck', views: ['trips'], kind: 'operations' };
    await save({ desks: [desk, desk] }, 422);
    await save({ desks: [{ ...desk, views: ['payroll'] }] }, 422);
    await save({ desks: [{ ...desk, icon: 'rocket' }] }, 422);
    await save({ desks: [{ ...desk, views: [] }] }, 422);
    await save({ desks: [{ ...desk, key: 'Yard Desk' }] }, 422);
  });

  test('anyone signed in can read the workspace; changing it needs the company permission', async () => {
    const viewer = await userWithRole(owner, 'viewer');
    assert.equal((await workspace(viewer)).words.trip!.singular, 'Trip');
    const company = (await api().get('/api/v1/company').set(bearer(owner)).expect(200)).body.data;
    await api().put('/api/v1/company').set(bearer(viewer)).send({ vocabulary: {}, version: company.version }).expect(403);
    await api().get('/api/v1/meta/workspace').expect(401);
  });
});
