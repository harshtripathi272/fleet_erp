// The profile library (#133, platform design phase 2): format 2 and its environments, migration from format 1,
// and the kit made from a profile and an environment, which is the kit a format-1 file has always made.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
// The masters' definitions, so a data file's master can be checked, as the kit CLI does.
import '../src/app.js';
import {
  PROFILE_FORMAT, buildKit, checkProfile, companyFileOf, companyFileSchema, demoLocal, environmentSchema, kitEntries, migrate1to2,
  profileKit, profileSchema, readAny, thisCopy, unzip, type CompanyFile,
} from '../src/profile/index.js';
// The old paths still answer, for whatever imports them.
import { companyFileSchema as oldSchema } from '../src/modules/setup/companyFile.js';
import { buildKit as oldBuildKit } from '../src/modules/setup/kit.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'kit');
const FORMAT_1 = join(import.meta.dirname, 'fixtures', 'profiles', 'format-1');
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
const fixture = () => companyFileSchema.parse(json(join(FIXTURE, 'company.json')));
const attachmentsOf = (file: Pick<CompanyFile, 'brand' | 'data'>) => new Map([file.brand.files.logo, ...file.data.files.map((f) => f.file)].filter((p): p is string => Boolean(p)).map((p) => [p, readFileSync(join(FIXTURE, p))]));

describe('format 2: a profile and its environments', () => {
  test('every format-1 fixture migrates to a profile and an environment that validate, losing nothing', () => {
    const names = readdirSync(FORMAT_1).filter((n) => n.endsWith('.json'));
    assert.ok(names.length >= 3);
    for (const name of names) {
      const file = companyFileSchema.parse(json(join(FORMAT_1, name)));
      const { profile, environment } = migrate1to2(file);
      assert.equal(profile.format, PROFILE_FORMAT, name);
      assert.equal(profile.revision, 1, name);
      assert.ok(!('deploy' in profile) && !('purpose' in profile), `${name}: where it runs is not in the profile`);
      // What the files say again, read as files: they validate on their own.
      assert.ok(profileSchema.safeParse(JSON.parse(JSON.stringify(profile))).success, name);
      assert.ok(environmentSchema.safeParse(JSON.parse(JSON.stringify(environment))).success, name);
      assert.equal(environment.target, file.deploy.target, name);
      assert.equal(environment.purpose, file.purpose === 'demo' ? 'demo' : 'production', name);
      // Joined again, it is the same company file, so the kit and the apply see exactly what they did.
      assert.deepEqual(companyFileOf(profile, environment), file, name);
    }
  });

  test('the environment is named after its target, and a demonstration on this computer is demo-local', () => {
    assert.equal(migrate1to2(fixture()).environment.name, 'compose');
    assert.equal(migrate1to2(companyFileSchema.parse(json(join(FORMAT_1, 'kumar-local.json')))).environment.name, 'demo-local');
    assert.equal(migrate1to2(companyFileSchema.parse(json(join(FORMAT_1, 'zed-demo-gcp.json')))).environment.name, 'gcp');
  });

  test('a profile refuses where it runs, and an environment refuses the company', () => {
    const { profile } = migrate1to2(fixture());
    const withDeploy = profileSchema.safeParse({ ...profile, deploy: { target: 'local' } });
    assert.ok(!withDeploy.success && withDeploy.error.issues.some((i) => /deploy/.test(JSON.stringify(i))));
    assert.ok(!profileSchema.safeParse({ ...profile, purpose: 'demo' }).success);
    assert.ok(!environmentSchema.safeParse({ ...demoLocal(), company: { key: 'x' } }).success);
  });

  test('an environment checks its own settings: Cloud Run pairs, a trial end only on a trial, names', () => {
    const gcp = { format: 2, name: 'trial', purpose: 'trial', trialEnds: '2026-11-26', target: 'gcp', projectId: 'acme-fleet-trial' } as const;
    assert.ok(environmentSchema.safeParse(gcp).success);
    const big = environmentSchema.safeParse({ ...gcp, memory: '8Gi', cpu: '1' });
    assert.ok(!big.success && big.error.issues.some((i) => i.path.join('.') === 'memory'));
    const ended = environmentSchema.safeParse({ ...gcp, purpose: 'production' });
    assert.ok(!ended.success && ended.error.issues.some((i) => i.path.join('.') === 'trialEnds'));
    assert.ok(!environmentSchema.safeParse({ ...gcp, name: 'Trial Copy' }).success);
    assert.ok(!environmentSchema.safeParse({ ...gcp, purpose: 'real' }).success, 'a copy is a demonstration, a trial or production');
    assert.equal(demoLocal(8085).port, 8085);
  });

  test('the vendor part: notes and the sections it would lock, recorded in the profile', () => {
    const { profile } = migrate1to2(fixture());
    const parsed = profileSchema.parse({ ...profile, vendor: { notes: 'Trial agreed 8 Nov; fuel only.', lockedSections: ['areas'] } });
    assert.deepEqual(parsed.vendor, { notes: 'Trial agreed 8 Nov; fuel only.', lockedSections: ['areas'] });
    assert.ok(!profileSchema.safeParse({ ...profile, vendor: { lockedSections: ['deploy'] } }).success);
  });

  test('readAny reads either format and says what is wrong where', () => {
    const one = readAny(json(join(FIXTURE, 'company.json')));
    assert.ok(one.ok && one.format === 1 && one.environment?.name === 'compose' && one.file);
    const { profile, environment } = migrate1to2(fixture());
    const two = readAny(JSON.parse(JSON.stringify(profile)), JSON.parse(JSON.stringify(environment)));
    assert.ok(two.ok && two.format === 2 && two.environment?.target === 'compose');
    const bad = readAny({ ...JSON.parse(JSON.stringify(profile)), owner: {} }, { format: 2, name: 'x', purpose: 'demo', target: 'nowhere' });
    assert.ok(!bad.ok);
    assert.ok(bad.problems.some((p) => p.path === 'owner.email'));
    assert.ok(bad.problems.some((p) => p.path.startsWith('environment')));
    const unknown = readAny({ format: 7 });
    assert.ok(!unknown.ok && /formats 1 and 2/.test(unknown.problems[0]!.message));
  });

  test('a copy applying a profile with no environment beside it takes its kind from its own settings', () => {
    const { profile } = migrate1to2(fixture());
    assert.equal(companyFileOf(profile, thisCopy('demo')).purpose, 'demo');
    assert.equal(companyFileOf(profile, thisCopy('trial')).purpose, 'real');
  });
});

describe('the kit from a profile and an environment', () => {
  test('is the kit the format-1 file has always made: the same entries, the same company.json', () => {
    const file = fixture();
    const attachments = attachmentsOf(file);
    const today = unzip(buildKit(file, attachments));
    const { profile, environment } = migrate1to2(file);
    const made = profileKit(profile, environment, attachments);
    assert.deepEqual(made.problems, []);
    const fromProfile = unzip(made.zip!);
    assert.deepEqual([...fromProfile.keys()].sort(), [...today.keys()].sort());
    for (const path of ['acme-haulage-kit/company.json', 'acme-haulage-kit/.env.example', 'acme-haulage-kit/deploy/kit.env', 'acme-haulage-kit/README.md']) {
      assert.equal(fromProfile.get(path)!.toString(), today.get(path)!.toString(), path);
    }
    assert.equal(made.name, 'acme-haulage-kit.zip');
  });

  test('a trial environment makes a trial copy, with its last day', () => {
    const { profile } = migrate1to2(fixture());
    const trial = environmentSchema.parse({ format: 2, name: 'trial', purpose: 'trial', trialEnds: '2026-11-26', target: 'compose', domain: 'trial.acme-haulage.example' });
    const entries = new Map(kitEntries(companyFileOf(profile, trial), attachmentsOf(profile), { purpose: 'trial', trialEnds: '2026-11-26' }).map((e) => [e.path, String(e.data)]));
    assert.match(entries.get('acme-haulage-kit/.env.example')!, /^COPY_PURPOSE=trial$/m);
    assert.match(entries.get('acme-haulage-kit/.env.example')!, /^TRIAL_ENDS=2026-11-26$/m);
    assert.match(entries.get('acme-haulage-kit/deploy/kit.env')!, /^TRIAL_ENDS=2026-11-26$/m);
    assert.match(entries.get('acme-haulage-kit/README.md')!, /A trial copy\*\* until 2026-11-26/);
    const made = profileKit(profile, trial, attachmentsOf(profile));
    assert.match(unzip(made.zip!).get('acme-haulage-kit/.env.example')!.toString(), /^COPY_PURPOSE=trial$/m);
  });

  test("an environment's problems are placed on the environment, the company's on the company", () => {
    const { profile } = migrate1to2(fixture());
    const noDomain = environmentSchema.parse({ format: 2, name: 'server', purpose: 'production', target: 'compose' });
    const problems = checkProfile(profile, noDomain, new Map());
    assert.ok(problems.some((p) => p.path === 'environments.server.domain'), JSON.stringify(problems));
    assert.ok(problems.some((p) => p.path === 'brand.files.logo'), 'the logo is missing');
    assert.ok(!profileKit(profile, noDomain, new Map()).zip);
  });

  test('the old paths re-export the library', () => {
    assert.equal(oldSchema, companyFileSchema);
    assert.equal(oldBuildKit, buildKit);
  });

  test('the library itself imports neither the server settings nor Mongoose', () => {
    const dir = join(import.meta.dirname, '..', 'src', 'profile');
    for (const name of readdirSync(dir)) {
      const text = readFileSync(join(dir, name), 'utf8');
      assert.doesNotMatch(text, /from '(\.\.\/)+config\/env\.js'/, `${name} imports the server's settings`);
      assert.doesNotMatch(text, /from 'mongoose'/, `${name} imports Mongoose`);
    }
  });
});
