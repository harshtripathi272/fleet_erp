// Fleet Studio (#133, platform design phase 4): from an empty workspace, a company made from a template, run on
// this computer, signed in to with its demonstration sign-ins, reset and stopped, with no terminal; two companies
// drafted at once, each save its own git commit; and the set-up's steps answered without a database.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { createStudio } from '../studio/server/index.js';
import { unzip } from '../src/profile/index.js';

const root = mkdtempSync(join(tmpdir(), 'fleet-studio-'));
const studio = createStudio({ root });
const call = () => request(studio.app);
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const PNG = readFileSync(join(import.meta.dirname, 'fixtures', 'kit', 'files', 'logo.png')).toString('base64');

let mongo: MongoMemoryServer;
before(async () => {
  mongo = await MongoMemoryServer.create();
  // A copy run without Docker uses this MongoDB; the screens aren't built in the tests, so it answers its API only.
  process.env.FLEET_LOCAL_MONGODB_URI = mongo.getUri().replace(/\/[^/]*$/, '');
  process.env.FLEET_SKIP_WEB_BUILD = '1';
});
after(async () => {
  await mongo?.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('Studio, from an empty workspace', () => {
  test('the workspace is made as a git folder, with the templates to start from', async () => {
    const ws = (await call().get('/api/v1/studio/workspace').expect(200)).body.data;
    assert.equal(ws.root, root);
    assert.deepEqual(ws.companies, []);
    assert.ok(existsSync(join(root, '.git')));
    assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /\.build\//);
    assert.deepEqual(ws.templates.map((t: { key: string }) => t.key), ['fuel-southern-africa', 'empty']);
  });

  test('answers only this computer, and only its own pages', async () => {
    await call().get('/api/v1/studio/workspace').set('Host', 'studio.evil.example').expect(403);
    await call().post('/api/v1/studio/companies').set('Origin', 'https://evil.example').send({ name: 'X', template: 'empty' }).expect(403);
  });

  test("the set-up's steps get their masters, areas, roles, words and services from the code", async () => {
    const masters = (await call().get('/api/v1/meta/masters').expect(200)).body.data as { key: string }[];
    assert.ok(masters.some((m) => m.key === 'vehicles') && masters.some((m) => m.key === 'drivers'));
    const areas = (await call().get('/api/v1/meta/areas').expect(200)).body.data as { key: string; on: boolean }[];
    assert.ok(areas.find((a) => a.key === 'trips')!.on);
    const roles = (await call().get('/api/v1/roles').expect(200)).body.data as { key: string }[];
    assert.ok(['owner', 'operations', 'finance'].every((k) => roles.some((r) => r.key === k)));
    assert.ok((await call().get('/api/v1/meta/workspace').expect(200)).body.data.terms.trip);
    const kinds = (await call().get('/api/v1/connection-kinds').expect(200)).body.data as { kind: string; via: string }[];
    assert.equal(kinds.find((k) => k.kind === 'email')!.via, 'simulated');
    const tried = await call().post('/api/v1/connections/test-draft').send({}).expect(409);
    assert.match(tried.body.error.message, /holds no keys/);
    const options = (await call().get('/api/v1/studio/options').expect(200)).body.data;
    assert.ok(options.targets.some((t: { key: string }) => t.key === 'local'));
    const csv = (await call().get('/api/v1/meta/import/vehicles/template').expect(200)).text;
    assert.match(csv, /Registration/);
  });
});

describe('two companies drafted at once', () => {
  test('each save is its own commit, with only its own files, as the next revision', async () => {
    await call().post('/api/v1/studio/companies').send({ name: 'Copperbelt Fuel Haulage', template: 'fuel-southern-africa' }).expect(200);
    await call().post('/api/v1/studio/companies').send({ name: 'Lakeside Couriers', template: 'empty' }).expect(200);
    await call().post('/api/v1/studio/companies').send({ name: 'Lakeside Couriers', template: 'empty' }).expect(409);
    const a = (await call().get('/api/v1/studio/companies/copperbelt-fuel-haulage').expect(200)).body.data;
    const b = (await call().get('/api/v1/studio/companies/lakeside-couriers').expect(200)).body.data;
    assert.equal(a.profile.company.legalName, 'Copperbelt Fuel Haulage');
    assert.equal(a.profile.owner.email, 'owner@copperbelt-fuel-haulage.test');
    assert.deepEqual(a.environments.map((e: { name: string }) => e.name), ['demo-local']);
    assert.notEqual(a.environments[0].port, b.environments[0].port, 'each copy on this computer gets its own port');

    // Both in progress: B's logo is in its folder, unsaved, while A is saved.
    const bProfile = { ...b.profile, regional: { country: 'MW', baseCurrency: 'MWK' }, brand: { files: { logo: 'files/logo.png' } } };
    await call().put('/api/v1/studio/companies/lakeside-couriers/files').send({ path: 'files/logo.png', data: PNG }).expect(200);
    await call().put('/api/v1/studio/companies/lakeside-couriers/draft').send({ profile: bProfile, environments: b.environments }).expect(200);
    const aProfile = { ...a.profile, brand: { ...a.profile.brand, productName: 'Copperbelt Fleet' } };
    const aEnv = [{ ...a.environments[0], port: 18731 }];
    await call().put('/api/v1/studio/companies/copperbelt-fuel-haulage/draft').send({ profile: aProfile, environments: aEnv }).expect(200);
    const savedA = (await call().post('/api/v1/studio/companies/copperbelt-fuel-haulage/save').send({ profile: aProfile, environments: aEnv }).expect(200)).body.data;
    assert.equal(savedA.revision, 2);
    assert.match(savedA.message, /copperbelt-fuel-haulage: revision 2 — brand/);
    assert.deepEqual(savedA.problems, []);
    assert.equal(git('log', '-1', '--format=%s'), savedA.message);
    assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['copperbelt-fuel-haulage/environments/demo-local.json', 'copperbelt-fuel-haulage/profile.json']);
    // B is still a draft, with its file, after A's save.
    const stillB = (await call().get('/api/v1/studio/companies/lakeside-couriers').expect(200)).body.data;
    assert.equal(stillB.draft.profile.regional.country, 'MW');
    assert.ok(stillB.attachments.some((x: { path: string }) => x.path === 'files/logo.png'));
    assert.match(git('status', '--porcelain'), /lakeside-couriers\/files\//);
    const savedB = (await call().post('/api/v1/studio/companies/lakeside-couriers/save').send({ profile: bProfile, environments: b.environments }).expect(200)).body.data;
    assert.equal(savedB.revision, 2);
    assert.ok(git('show', '--name-only', '--format=', 'HEAD').includes('lakeside-couriers/files/logo.png'));
    assert.equal(git('status', '--porcelain'), '', 'nothing left uncommitted');
    const history = (await call().get('/api/v1/studio/companies/lakeside-couriers/history').expect(200)).body.data as { message: string }[];
    assert.deepEqual(history.map((h) => h.message), [savedB.message, 'lakeside-couriers: created from the template "Empty"']);
  });

  test('a draft can be thrown away, files and all', async () => {
    await call().put('/api/v1/studio/companies/lakeside-couriers/files').send({ path: 'data/vehicles.csv', data: Buffer.from('Registration number *\nABC 123\n').toString('base64') }).expect(200);
    const checked = (await call().post('/api/v1/setup-kit/check-sheet').set('X-Fleet-Company', 'lakeside-couriers').send({ master: 'vehicles', path: 'data/vehicles.csv' }).expect(200)).body.data;
    assert.equal(checked.rows, 1);
    assert.equal(checked.checkedHere, 'columns');
    await call().post('/api/v1/studio/companies/lakeside-couriers/discard').expect(200);
    assert.ok(!existsSync(join(root, 'lakeside-couriers', 'data', 'vehicles.csv')));
    assert.ok(existsSync(join(root, 'lakeside-couriers', 'files', 'logo.png')), 'what was saved stays');
  });

  test('what is wrong is said where it is, and the kit is made from what is saved', async () => {
    const b = (await call().get('/api/v1/studio/companies/lakeside-couriers').expect(200)).body.data;
    const problems = (await call().post('/api/v1/studio/companies/lakeside-couriers/check').send({ profile: { ...b.profile, regional: {} }, environments: [{ ...b.environments[0], port: 80 }] }).expect(200)).body.data.problems as { path: string }[];
    assert.ok(problems.some((p) => p.path === 'regional.country'));
    assert.ok(problems.some((p) => p.path === 'environments.demo-local.port'));
    const kit = await call().get('/api/v1/studio/companies/copperbelt-fuel-haulage/environments/demo-local/kit').buffer(true).parse((res, done) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => done(null, Buffer.concat(chunks))); }).expect(200);
    const entries = unzip(kit.body as Buffer);
    assert.match(entries.get('copperbelt-fuel-haulage-kit/company.json')!.toString(), /Copperbelt Fleet/);
    assert.match(entries.get('copperbelt-fuel-haulage-kit/.env.example')!.toString(), /^COPY_PURPOSE=demo$/m);
  });

  test('a format-1 file is imported as a profile and its environment', async () => {
    const file = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'profiles', 'format-1', 'kumar-local.json'), 'utf8'));
    const res = await call().post('/api/v1/studio/companies/import').send({ file });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const out = res.body.data;
    assert.deepEqual(out, { key: 'kumar-parcels', problems: [], migrated: true });
    const k = (await call().get('/api/v1/studio/companies/kumar-parcels').expect(200)).body.data;
    assert.equal(k.profile.format, 2);
    assert.equal(k.environments[0].name, 'demo-local');
    await call().post('/api/v1/studio/companies/kumar-parcels/remove').send({ confirm: 'nope' }).expect(400);
    await call().post('/api/v1/studio/companies/kumar-parcels/remove').send({ confirm: 'kumar-parcels' }).expect(200);
    assert.ok(!existsSync(join(root, 'kumar-parcels')));
    assert.match(git('log', '-1', '--format=%s'), /kumar-parcels: removed/);
  });
});

describe('a demonstration run on this computer', () => {
  const at = '/api/v1/studio/companies/copperbelt-fuel-haulage/environments/demo-local';
  const signIn = (login: string, password: string) => fetch('http://localhost:18731/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: login, password }) });

  test('started, signed in to with its sign-ins, reset with new ones, stopped and removed', { timeout: 10 * 60_000 }, async () => {
    await call().post(`${at}/up`).send({ engine: 'node' }).expect(200);
    const started = await studio.runs.settle('copperbelt-fuel-haulage', 'demo-local');
    const run = (await call().get(`${at}/run`).expect(200)).body.data;
    assert.equal(run.error, undefined, `${started?.lines.join('\n')}\n${(await studio.runs.logs('copperbelt-fuel-haulage', 'demo-local', 40)).join('\n')}`);
    assert.equal(run.status.state, 'running');
    assert.equal(run.status.url, 'http://localhost:18731');
    // The copy is the company: its profile applied, with the sample operation.
    const brand = await (await fetch('http://localhost:18731/api/v1/brand')).json() as { data: { productName: string } };
    assert.equal(brand.data.productName, 'Copperbelt Fleet');
    assert.equal(run.signIns.owner.email, 'owner@copperbelt-fuel-haulage.test');
    assert.equal((await signIn(run.signIns.owner.email, run.signIns.owner.password)).status, 200, 'the owner signs in');
    const operations = (run.signIns.logins as { login: string; password: string }[]).find((l) => l.login === 'operations@copperbelt-fuel-haulage.test');
    assert.ok(operations, `${run.job} ${JSON.stringify(run.signIns)}\n${run.lines.join("\n")}`);
    assert.equal((await signIn(operations!.login, operations!.password)).status, 200, 'a desk signs in');
    assert.ok(run.signIns.logins.some((l: { role: string }) => /^Driver/.test(l.role)), 'and a driver');
    const table = (await call().get('/api/v1/studio/workspace').expect(200)).body.data.companies.find((c: { key: string }) => c.key === 'copperbelt-fuel-haulage');
    assert.equal(table.environments[0].state, 'running');

    await call().post(`${at}/reset`).send({}).expect(200);
    await studio.runs.settle('copperbelt-fuel-haulage', 'demo-local');
    const after = (await call().get(`${at}/run`).expect(200)).body.data;
    assert.equal(after.error, undefined, after.lines.join('\n'));
    const fresh = (after.signIns.logins as { login: string; password: string }[]).find((l) => l.login === operations!.login)!;
    assert.notEqual(fresh.password, operations!.password, 'new sign-ins');
    assert.equal((await signIn(fresh.login, fresh.password)).status, 200);
    assert.equal((await signIn(operations!.login, operations!.password)).status, 401, 'the old ones are gone');
    const logs = (await call().get(`${at}/logs`).expect(200)).body.data as string[];
    assert.ok(logs.some((l) => /Company file/.test(l)), logs.slice(-10).join('\n'));

    await call().post(`${at}/down`).send({}).expect(200);
    await studio.runs.settle('copperbelt-fuel-haulage', 'demo-local');
    assert.equal((await call().get(`${at}/run`).expect(200)).body.data.status.state, 'stopped');
    await call().post(`${at}/down`).send({ remove: true }).expect(200);
    await studio.runs.settle('copperbelt-fuel-haulage', 'demo-local');
    assert.ok(!existsSync(join(root, 'copperbelt-fuel-haulage', '.build', 'demo-local')));
    assert.equal(git('status', '--porcelain'), '', 'a run leaves nothing to commit');
  });
});
