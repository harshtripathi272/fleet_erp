// #95: This installation. What kind of copy it is comes from its environment; a demonstration resets every
// time; a configuration file is previewed before it is applied; and production refuses to start as a demo by mistake.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { env, envSchema } from '../src/config/env.js';
import { getMaster } from '../src/core/masters/registry.js';
import { api, bearer, loadSample, resetDatabase, signUp, startDatabase, stopDatabase, userWithRole, type Session } from './helpers.js';

before(startDatabase);
after(stopDatabase);
const count = (master: string) => getMaster(master)!.model.countDocuments({});
const companyName = async (s: Session) => String((await api().get('/api/v1/company').set(bearer(s)).expect(200)).body.data.tradingName || (await api().get('/api/v1/company').set(bearer(s)).expect(200)).body.data.legalName);

describe('This installation', () => {
  let owner: Session;
  beforeEach(async () => {
    await resetDatabase();
    owner = await signUp('First Owner');
    env.COPY_PURPOSE = 'demo';
    env.TRIAL_ENDS = undefined;
  });

  test('the public facts say what kind of copy this is, and nothing about the company\'s people or settings', async () => {
    env.COPY_PURPOSE = 'trial';
    env.TRIAL_ENDS = '2099-12-31';
    const about = (await api().get('/api/v1/installation/about').expect(200)).body.data;
    assert.equal(about.purpose, 'trial');
    assert.equal(about.trialEnds, '2099-12-31');
    assert.ok(about.trialDaysLeft > 3);
    assert.deepEqual(Object.keys(about).sort(), ['product', 'purpose', 'trialDaysLeft', 'trialEnds', 'version']);
    const signIn = (await api().get('/api/v1/auth/options').expect(200)).body.data;
    assert.equal(signIn.trialEnds, '2099-12-31');
  });

  test('a demonstration resets every time, back to the same sample', async () => {
    await loadSample(owner);
    const vehicles = await count('vehicles');
    assert.ok(vehicles > 0);
    const name = await companyName(owner);
    await api().post('/api/v1/installation/reset').set(bearer(owner)).send({ confirm: 'not the name' }).expect(422);
    for (const round of [1, 2]) {
      const out = (await api().post('/api/v1/installation/reset').set(bearer(owner)).send({ confirm: name }).expect(200)).body.data;
      assert.equal(out.results[0].step, 'clear');
      assert.equal(await count('vehicles'), vehicles, `round ${round}: the sample is back`);
    }
  });

  test('a trial or production copy has no reset, and only an owner may reset a demonstration', async () => {
    await loadSample(owner);
    const admin = await userWithRole(owner, 'admin');
    await api().post('/api/v1/installation/reset').set(bearer(admin)).send({ confirm: 'x' }).expect(403);
    for (const purpose of ['trial', 'production'] as const) {
      env.COPY_PURPOSE = purpose;
      const refused = await api().post('/api/v1/installation/reset').set(bearer(owner)).send({ confirm: await companyName(owner) }).expect(403);
      assert.match(refused.body.error.message, /only a demonstration copy can be reset/);
    }
    assert.ok((await count('vehicles')) > 0, 'nothing removed');
    const status = (await api().get('/api/v1/installation/status').set(bearer(owner)).expect(200)).body.data;
    assert.equal(status.purpose, 'production');
  });

  test('a configuration file is previewed section by section before anything changes', async () => {
    await loadSample(owner);
    const exported = (await api().get('/api/v1/installation/export').set(bearer(owner)).expect(200)).body.data.file;
    // Never applied from a file: every section is set up for the first time.
    const first = (await api().post('/api/v1/installation/apply/preview').set(bearer(owner)).send({ file: exported }).expect(200)).body.data;
    assert.equal(first.ok, true);
    assert.ok(first.sections.length > 5 && first.sections.every((s: { change: string }) => s.change === 'new'));
    const before = await count('vehicles');
    assert.equal(await count('vehicles'), before, 'a preview changes nothing');

    const bad = (await api().post('/api/v1/installation/apply/preview').set(bearer(owner)).send({ file: { format: 1 } }).expect(200)).body.data;
    assert.equal(bad.ok, false);
    assert.ok(bad.problems.length > 0);

    env.COPY_PURPOSE = 'production';
    const demoFile = (await api().post('/api/v1/installation/apply/preview').set(bearer(owner)).send({ file: { ...exported, purpose: 'demo' } }).expect(200)).body.data;
    assert.equal(demoFile.ok, false);
    assert.match(demoFile.problems[0].message, /demonstration file can't be applied/);
  });

  test('production refuses to start as a demonstration unless it is meant to be one', () => {
    const base = {
      NODE_ENV: 'production', MONGODB_URI: 'mongodb://db/fleet', JWT_SECRET: 'a'.repeat(48), APP_URL: 'https://fleet.example.com',
      OWNER_EMAIL: 'owner@example.com', OWNER_PASSWORD: 'Str0ng-and-long-password', CORS_ORIGINS: 'https://fleet.example.com',
    };
    const demo = envSchema.safeParse({ ...base, COPY_PURPOSE: 'demo' });
    assert.equal(demo.success, false);
    assert.ok(demo.error!.issues.some((i) => i.path[0] === 'COPY_PURPOSE'));
    assert.equal(envSchema.safeParse({ ...base, COPY_PURPOSE: 'demo', DEMO_IN_PRODUCTION: 'true' }).success, true);
    const plain = envSchema.parse(base);
    assert.equal(plain.COPY_PURPOSE, 'production', 'production is the default in production');
  });
});
