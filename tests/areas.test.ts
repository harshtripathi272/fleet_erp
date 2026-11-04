import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { dispatch } from '../src/modules/messaging/dispatcher.js';
import { api, bearer, loadSample, signUp, startDatabase, stopDatabase, type Session } from './helpers.js';

/** Areas switch whole features on and off (#56). */
let owner: Session;
before(async () => {
  await startDatabase();
  owner = await signUp('Owner');
  await loadSample(owner);
});
after(stopDatabase);

const setAreas = async (modules: string[]) => {
  const company = (await api().get('/api/v1/company').set(bearer(owner)).expect(200)).body.data;
  await api().put('/api/v1/company').set(bearer(owner)).send({ modules, version: company.version }).expect(200);
};
const areas = async () => (await api().get('/api/v1/meta/areas').set(bearer(owner)).expect(200)).body.data as { key: string; on: boolean; state: string; masters: string[] }[];
const masterKeys = async () => ((await api().get('/api/v1/meta/masters').set(bearer(owner)).expect(200)).body.data as { key: string }[]).map((m) => m.key);

describe('areas', () => {
  test('the server lists every area, whether it is on, and its masters; areas not built are never on', async () => {
    const list = await areas();
    const by = (k: string) => list.find((a) => a.key === k)!;
    assert.equal(by('masters').on, true);
    assert.equal(by('maintenance').state, 'not-built');
    assert.equal(by('maintenance').on, false);
    assert.ok(by('finance').masters.includes('expense-categories'));
    assert.ok(by('trips').masters.includes('trip-types'));
  });

  test("an area that is off hides its masters and refuses them; switching it back on brings everything back", async () => {
    const before = (await api().get('/api/v1/expense-categories').set(bearer(owner)).expect(200)).body.data.length;
    await setAreas(['masters', 'trips', 'tracking', 'driver-app']);
    assert.equal((await areas()).find((a) => a.key === 'finance')!.on, false);
    assert.ok(!(await masterKeys()).includes('expense-categories'));
    const refused = await api().get('/api/v1/expense-categories').set(bearer(owner)).expect(403);
    assert.match(refused.body.error.message, /Money is switched off/);
    await setAreas(['masters', 'trips', 'finance', 'tracking', 'driver-app']);
    assert.ok((await masterKeys()).includes('expense-categories'));
    assert.equal((await api().get('/api/v1/expense-categories').set(bearer(owner)).expect(200)).body.data.length, before, 'nothing was lost');
  });

  test('a master that belongs to no area is never hidden', async () => {
    await setAreas(['masters']);
    const keys = await masterKeys();
    assert.ok(keys.includes('vehicles') && keys.includes('drivers'));
    await setAreas(['masters', 'trips', 'finance', 'tracking', 'driver-app']);
  });

  test("events of an area that is off send nothing", async () => {
    await setAreas(['masters', 'trips', 'tracking', 'driver-app']);
    assert.deepEqual(await dispatch({ event: 'fund_request.created', variables: { amount: 10 } }), []);
    await setAreas(['masters', 'trips', 'finance', 'tracking', 'driver-app']);
  });

  test('an area that is not built cannot be switched on', async () => {
    await setAreas(['masters', 'trips', 'finance', 'maintenance']);
    assert.equal((await areas()).find((a) => a.key === 'maintenance')!.on, false);
  });
});
