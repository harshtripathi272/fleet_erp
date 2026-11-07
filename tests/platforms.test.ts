// #103: a package for this computer runs with one command; every platform builds the app from the source in
// its package, so no image is needed beforehand; each platform's guide is complete; a demonstration copy says so.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, before, beforeEach, describe, test } from 'node:test';
import { TARGETS, companyFileSchema, type CompanyFile } from '../src/modules/setup/companyFile.js';
import { TARGET_FIELDS, TARGET_NEEDS, guideSteps, runningOnGoogle } from '../src/modules/setup/guide.js';
import { appSource, buildKit, checkKit, envTemplate } from '../src/modules/setup/kit.js';
import { unzip } from '../src/modules/setup/zip.js';
import { api, bearer, loadSample, resetDatabase, signUp, startDatabase, stopDatabase } from './helpers.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'kit');
const fixture = () => JSON.parse(readFileSync(join(FIXTURE, 'company.json'), 'utf8')) as Record<string, any>;
const attachmentsOf = (file: CompanyFile) => new Map([file.brand.files.logo, ...file.data.files.map((f) => f.file)].filter((p): p is string => Boolean(p)).map((p) => [p, readFileSync(join(FIXTURE, p))]));
const forTarget = (deploy: Record<string, unknown>) => companyFileSchema.parse({ ...fixture(), deploy: { ...deploy } });

describe('this computer', () => {
  test('a package that starts with one command, its own database and files, at localhost', () => {
    assert.ok(appSource(), 'the tests run in the repository, so the source is there');
    const file = forTarget({ target: 'local', port: 8090 });
    assert.deepEqual(checkKit(file, attachmentsOf(file)), [], 'no domain, image or e-mail server needed');
    const entries = unzip(buildKit(file, attachmentsOf(file)));
    const at = (p: string) => entries.get(`acme-haulage-kit/${p}`);
    for (const p of ['start.sh', 'start.command', 'start.bat', 'docker-compose.yml', 'Dockerfile', 'app-source.tar.gz']) assert.ok(at(p), `${p} is in the package`);
    assert.match(at('start.bat')!.toString(), /\r\n/, 'Windows line endings, so a double-click runs it');
    assert.match(at('Dockerfile')!.toString(), /ADD app-source\.tar\.gz/, 'the image is built from the source');
    assert.match(at('docker-compose.yml')!.toString(), /127\.0\.0\.1:\$\{PORT:-8080\}:3000/);
    const env = at('.env.example')!.toString();
    assert.match(env, /^NODE_ENV=development$/m, 'production refuses a plain http address');
    assert.match(env, /^APP_URL=http:\/\/localhost:8090$/m);
    assert.match(env, /^OWNER_PASSWORD=$/m, 'the start script fills it in');
    assert.match(env, /^MONGODB_URI=mongodb:\/\/mongo:27017\/fleet$/m);
    assert.match(at('deploy/kit.env')!.toString(), /^PORT=8090$/m);
    assert.match(at('README.md')!.toString(), /Docker Desktop/);
    for (const script of ['start.sh', 'start.command']) assert.equal(spawnSync('bash', ['-n', '-c', at(script)!.toString()]).status, 0, `${script} is valid bash`);
    const steps = guideSteps(file).map((s) => s.title);
    assert.deepEqual(steps, ['Install Docker Desktop', 'Unzip the package and start it', 'Sign in', 'Stop or start it again']);
  });
});

describe('every platform', () => {
  test('builds from the source in its package; none needs an image named first', () => {
    for (const target of ['compose', 'aws', 'azure', 'render', 'fly', 'railway'] as const) {
      const raw = fixture();
      const deploy: Record<string, unknown> = { target, domain: 'fleet.acme-haulage.example', smtp: raw.deploy.smtp };
      if (target === 'aws') raw.connections.push({ code: 'FILES', name: 'S3', kind: 'storage', provider: 's3', enabled: true, settings: { bucket: 'acme-files' }, secrets: { accessKeyId: 'CONNECTION_S3_ID', secretAccessKey: 'CONNECTION_S3_SECRET' } });
      const file = companyFileSchema.parse({ ...raw, deploy });
      assert.deepEqual(checkKit(file, attachmentsOf(file)), [], target);
      const entries = unzip(buildKit(file, attachmentsOf(file)));
      assert.ok(entries.has('acme-haulage-kit/app-source.tar.gz'), `${target} carries the source`);
      assert.match(entries.get('acme-haulage-kit/Dockerfile')!.toString(), /ADD app-source\.tar\.gz/, target);
      assert.match(entries.get('acme-haulage-kit/deploy/kit.env')!.toString(), /^APP_VERSION=[0-9a-f]{7,}$/m, `${target}: the version to build`);
    }
    const compose = envTemplate(forTarget({ target: 'compose', domain: 'fleet.acme-haulage.example', smtp: fixture().deploy.smtp }));
    assert.doesNotMatch(compose, /^FLEET_IMAGE=/m, 'no image to name for Compose');
    assert.match(compose, /^FLEET_VERSION=[0-9a-f]{7,}$/m);
  });

  test('each has what it needs, its fields, and steps with the commands to run', () => {
    for (const target of TARGETS) {
      assert.ok(TARGET_NEEDS[target].length >= 1, `${target} says what it needs`);
      assert.ok(TARGET_FIELDS[target], `${target} has fields`);
    }
    const scripts: Record<string, string> = { aws: 'deploy/aws.sh', azure: 'deploy/azure.sh', render: 'deploy/render.sh', fly: 'deploy/fly.sh', railway: 'deploy/railway.sh' };
    for (const [target, script] of Object.entries(scripts)) {
      const raw = fixture();
      const steps = guideSteps(companyFileSchema.parse({ ...raw, deploy: { target, domain: 'fleet.acme-haulage.example', smtp: raw.deploy.smtp } }));
      const commands = steps.flatMap((s) => s.commands ?? []);
      assert.ok(commands.includes(script), `${target}: runs ${script}, with no version to name`);
      assert.ok(steps.some((s) => /not yet run against a real account/.test(s.text ?? '')), `${target}: says honestly it hasn't been run`);
      assert.ok(steps.some((s) => s.title === 'Check it worked'), `${target}: ends with a check`);
    }
  });
});

describe('running it on Google Cloud (#104)', () => {
  test("alerts, cost, backups, going back and changing it later, with this company's names", () => {
    const file = forTarget({ target: 'gcp', projectId: 'acme-fleet-prod', region: 'europe-west1', domain: 'fleet.acme-haulage.example', alertEmail: 'it@acme-haulage.example', monthlyBudget: 120, smtp: fixture().deploy.smtp });
    const steps = runningOnGoogle(file);
    assert.deepEqual(steps.map((s) => s.title.replace(/^Running it: /, '')), ["knowing it's down or failing", 'what it costs', 'backups and restoring them', 'upgrades and going back a version', 'changing the company later']);
    const all = JSON.stringify(steps);
    assert.match(all, /it@acme-haulage\.example/);
    assert.match(all, /gcloud run services update-traffic fleet-acme-haulage --to-revisions <revision>=100 --region europe-west1 --project acme-fleet-prod/);
    assert.match(all, /gs:\/\/acme-fleet-prod-acme-haulage-files/);
    assert.match(all, /A budget of 120 a month/);
    assert.doesNotMatch(all, /US\$|\$\d/, 'no prices are guessed');
    assert.equal(guideSteps(file).filter((s) => s.title.startsWith('Running it')).length, 5, 'the deploy guide includes them');
    const entries = unzip(buildKit(file, attachmentsOf(file)));
    assert.match(entries.get('acme-haulage-kit/deploy/kit.env')!.toString(), /^ALERT_EMAIL=it@acme-haulage\.example$/m);
    assert.match(entries.get('acme-haulage-kit/deploy/kit.env')!.toString(), /^BUDGET_MONTHLY=120$/m);
    assert.match(entries.get('acme-haulage-kit/README.md')!.toString(), /## Running it/);
  });
});

describe('a demonstration copy', () => {
  before(startDatabase);
  after(stopDatabase);
  beforeEach(resetDatabase);

  test('says it holds made-up data, on the sign-in page and in its README', async () => {
    assert.equal((await api().get('/api/v1/auth/options').expect(200)).body.data.demo, false);
    const owner = await signUp('Owner');
    await loadSample(owner);
    assert.equal((await api().get('/api/v1/auth/options').expect(200)).body.data.demo, true);
    await api().get('/api/v1/me').set(bearer(owner));
    const demo = forTarget({ target: 'local', port: 8090 });
    const readme = unzip(buildKit({ ...demo, data: { ...demo.data, sample: 'small' } }, attachmentsOf(demo))).get('acme-haulage-kit/README.md')!.toString();
    assert.match(readme, /This copy holds made-up data/);
  });
});
