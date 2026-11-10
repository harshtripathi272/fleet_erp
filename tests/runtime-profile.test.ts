// #133: the company app reads a profile (format 2) as well as a company file (format 1): on start from
// COMPANY_CONFIG, with environment.json beside it if there is one, and on This installation's apply. A
// demonstration Studio started asks it for its sign-ins.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { env } from '../src/config/env.js';
import { getMaster } from '../src/core/masters/registry.js';
import { Company } from '../src/modules/company/company.model.js';
import { applyCompanyFile, lastApplied, readCompanyFile } from '../src/modules/setup/apply.js';
import { companyFileSchema, json, migrate1to2, writeFolder } from '../src/profile/index.js';
import { api, bearer, resetDatabase, signUp, startDatabase, stopDatabase, userWithRole } from './helpers.js';

before(startDatabase);
after(stopDatabase);

const FIXTURE = join(import.meta.dirname, 'fixtures', 'kit');
const count = (master: string) => getMaster(master)!.model.countDocuments({});

/** The kit fixture as a profile, with its files, in a folder of its own; and an environment.json beside it if given. */
function profileFolder(environment?: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-profile-'));
  const { profile } = migrate1to2(companyFileSchema.parse(JSON.parse(readFileSync(join(FIXTURE, 'company.json'), 'utf8'))));
  const files = new Map([profile.brand.files.logo!, ...profile.data.files.map((f) => f.file)].map((p) => [p, readFileSync(join(FIXTURE, p))]));
  writeFolder(dir, profile, [], files);
  if (environment) writeFileSync(join(dir, 'environment.json'), json(environment));
  return { dir, profile };
}

describe('a profile applied on start', () => {
  beforeEach(async () => { await resetDatabase(); env.COPY_PURPOSE = 'demo'; });

  test('with environment.json beside it: the company, its data and what kind of copy it is', async () => {
    const { dir } = profileFolder({ format: 2, name: 'trial', purpose: 'trial', trialEnds: '2026-11-26', target: 'compose', domain: 'trial.acme-haulage.example' });
    const first = await applyCompanyFile(join(dir, 'profile.json'));
    assert.ok(first.applied);
    assert.deepEqual(first.results.filter((r) => r.outcome === 'failed'), []);
    const company = await Company.findOne().lean<Record<string, any>>();
    assert.equal(company!.legalName, 'Acme Haulage Ltd');
    assert.equal(await count('vehicles'), 2);
    assert.equal((await lastApplied())!.purpose, 'real', 'a trial is a real company');
    // Started again with nothing changed, nothing is applied.
    assert.equal((await applyCompanyFile(join(dir, 'profile.json'))).applied, false);
    // A changed environment counts as a change, and nothing is applied twice.
    writeFileSync(join(dir, 'environment.json'), json({ format: 2, name: 'production', purpose: 'production', target: 'compose', domain: 'fleet.acme-haulage.example' }));
    assert.equal((await applyCompanyFile(join(dir, 'profile.json'))).applied, true);
    assert.equal(await count('vehicles'), 2);
    rmSync(dir, { recursive: true, force: true });
  });

  test('without one, the copy is what its own settings say', async () => {
    const { dir } = profileFolder();
    await applyCompanyFile(join(dir, 'profile.json'));
    assert.equal((await lastApplied())!.purpose, 'demo');
  });

  test('a profile with problems is refused, each problem with its place', async () => {
    const { dir, profile } = profileFolder({ format: 2, name: 'x', purpose: 'demo', target: 'nowhere' });
    await assert.rejects(readCompanyFile(join(dir, 'profile.json')), /not a valid profile[\s\S]*environment/);
    writeFileSync(join(dir, 'profile.json'), json({ ...profile, owner: {} }));
    rmSync(join(dir, 'environment.json'));
    await assert.rejects(readCompanyFile(join(dir, 'profile.json')), /owner\.email/);
  });
});

describe('a profile applied from This installation', () => {
  beforeEach(async () => { await resetDatabase(); env.COPY_PURPOSE = 'demo'; });

  test('previewed, then applied, as a company file is', async () => {
    const owner = await signUp('First Owner');
    const { profile } = migrate1to2(companyFileSchema.parse({ ...JSON.parse(readFileSync(join(FIXTURE, 'company.json'), 'utf8')), brand: { productName: 'Acme Fleet' }, data: { sample: 'starter' } }));
    const file = JSON.parse(JSON.stringify({ ...profile, owner: { email: owner.email } }));
    const preview = (await api().post('/api/v1/installation/apply/preview').set(bearer(owner)).send({ file }).expect(200)).body.data;
    assert.ok(preview.ok, JSON.stringify(preview.problems));
    assert.ok(preview.sections.some((s: { key: string; change: string }) => s.key === 'company' && s.change === 'new'));
    const res = await api().post('/api/v1/setup-kit/apply').set(bearer(owner)).send({ file }).expect(200);
    const lines = res.text.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.at(-1).type, 'done', res.text);
    assert.equal((await Company.findOne().lean<Record<string, any>>())!.brand.productName, 'Acme Fleet');
  });
});

describe("a demonstration's sign-ins", () => {
  beforeEach(async () => { await resetDatabase(); env.COPY_PURPOSE = 'demo'; });

  test('made once for each desk, only on a demonstration, only for an owner', async () => {
    const owner = await signUp('First Owner');
    await api().post('/api/v1/installation/demo-logins').set(bearer(owner)).send({}).expect(422);
    const { profile } = migrate1to2(companyFileSchema.parse({ ...JSON.parse(readFileSync(join(FIXTURE, 'company.json'), 'utf8')), brand: {}, data: { sample: 'small' } }));
    const res = await api().post('/api/v1/setup-kit/apply').set(bearer(owner)).send({ file: JSON.parse(JSON.stringify({ ...profile, owner: { email: owner.email } })) }).expect(200);
    assert.equal(res.text.trim().split('\n').map((l) => JSON.parse(l)).at(-1).type, 'done', res.text);
    // The apply made them already; a copy started from a profile has none until asked.
    await getMaster('users')!.model.deleteMany({ email: /\.test$/, _id: { $ne: owner.userId } });
    const made = (await api().post('/api/v1/installation/demo-logins').set(bearer(owner)).send({}).expect(200)).body.data.logins as { role: string; login: string; password: string }[];
    assert.ok(made.some((l) => l.login === 'operations@acme-haulage.test'), JSON.stringify(made));
    const signIn = made.find((l) => l.login === 'operations@acme-haulage.test')!;
    await api().post('/api/v1/auth/login').send({ email: signIn.login, password: signIn.password }).expect(200);
    const again = (await api().post('/api/v1/installation/demo-logins').set(bearer(owner)).send({}).expect(200)).body.data.logins;
    assert.ok(!again.some((l: { login: string }) => l.login === 'operations@acme-haulage.test'), 'shown once');
    const admin = await userWithRole(owner, 'admin');
    await api().post('/api/v1/installation/demo-logins').set(bearer(admin)).send({}).expect(403);
    env.COPY_PURPOSE = 'production';
    await api().post('/api/v1/installation/demo-logins').set(bearer(owner)).send({}).expect(403);
    env.COPY_PURPOSE = 'demo';
  });
});
