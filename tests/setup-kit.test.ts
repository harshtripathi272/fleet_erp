// #76: the company file, the kit made from it, and the server applying it on start, again and again.
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { env, envSchema } from '../src/config/env.js';
import { clearMail, recentMail } from '../src/core/mail/mailer.js';
import { getMaster } from '../src/core/masters/registry.js';
import { Company } from '../src/modules/company/company.model.js';
import { saveCompany } from '../src/modules/company/company.service.js';
import { Connection } from '../src/modules/connections/connection.model.js';
import { StoredFile } from '../src/modules/files/file.model.js';
import { Role } from '../src/modules/roles/role.model.js';
import { applyCompanyFile, readCompanyFile } from '../src/modules/setup/apply.js';
import { companyFileSchema, type CompanyFile } from '../src/modules/setup/companyFile.js';
import { readCsv } from '../src/modules/setup/csv.js';
import { buildKit, checkKit, envTemplate } from '../src/modules/setup/kit.js';
import { unzip } from '../src/modules/setup/zip.js';
import { User } from '../src/modules/users/user.model.js';
import { api, bearer, resetDatabase, signUp, startDatabase, stopDatabase, userWithRole, type Session } from './helpers.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'kit');
const fixture = () => JSON.parse(readFileSync(join(FIXTURE, 'company.json'), 'utf8')) as Record<string, any>;
const parsed = (raw = fixture()) => companyFileSchema.parse(raw);
/** The fixture's files, as the kit carries them. */
const attachmentsOf = (file: CompanyFile, dir = FIXTURE) => new Map(
  [file.brand.files.logo, ...file.data.files.map((f) => f.file)].filter((p): p is string => Boolean(p)).map((p) => [p, readFileSync(join(dir, p))]),
);
/** A copy of the fixture kit to change. */
function copyKit() {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-kit-'));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}
const rewrite = (dir: string, change: (f: Record<string, any>) => void) => {
  const f = JSON.parse(readFileSync(join(dir, 'company.json'), 'utf8'));
  change(f);
  writeFileSync(join(dir, 'company.json'), JSON.stringify(f, null, 2));
};
const count = (master: string, filter: Record<string, unknown> = {}) => getMaster(master)!.model.countDocuments(filter);

env.FILE_STORAGE_DIR = mkdtempSync(join(tmpdir(), 'fleet-files-'));
before(startDatabase);
after(stopDatabase);

describe('the company file', () => {
  test('the example file is valid, and names secrets without holding them', () => {
    const file = parsed();
    assert.equal(file.company.key, 'acme-haulage');
    assert.deepEqual(file.connections[0]!.secrets, { apiKey: 'CONNECTION_AT_KEY' });
    assert.equal(file.data.sample, 'none', 'no sample data unless asked');
  });

  test('a secret value, an unknown field or a provider\'s missing setting is refused with where it is', () => {
    const problems = (change: (f: Record<string, any>) => void) => {
      const f = fixture();
      change(f);
      const r = companyFileSchema.safeParse(f);
      return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    };
    assert.match(problems((f) => { f.connections[0].secrets.apiKey = 'atsk_live_9f8e7d6c5b4a'; }).join(), /connections\.0\.secrets\.apiKey/);
    assert.match(problems((f) => { f.deploy.smtp.password = 'hunter2hunter2'; }).join(), /deploy\.smtp/);
    assert.match(problems((f) => { delete f.connections[0].settings.username; }).join(), /connections\.0\.settings\.username/);
    assert.match(problems((f) => { f.connections[0].provider = 'nope'; }).join(), /No sms provider "nope"/);
    assert.match(problems((f) => { f.staff.push({ email: f.owner.email }); }).join(), /owner is set under owner/);
    assert.match(problems((f) => { f.connections.push({ ...f.connections[0], code: 'SMS2' }); }).join(), /Only one sms connection can be switched on/);
    assert.match(problems((f) => { f.format = 2; }).join(), /^format/);
  });

  test('CSV is read with commas or semicolons, quotes and a byte-order mark', () => {
    assert.deepEqual(readCsv('﻿Code *;Name *\r\nT1;"Volvo; FH"\r\n\r\n'), [{ 'Code *': 'T1', 'Name *': 'Volvo; FH' }]);
    assert.deepEqual(readCsv('a,b\n"say ""hi""",2'), [{ a: 'say "hi"', b: '2' }]);
  });
});

describe('the kit', () => {
  test('carries the file, its files, every server setting and the target\'s scripts, and no secret value', () => {
    const secretValues = ['atsk_live_9f8e7d6c5b4a', 'smtp-password-123', 'mongodb+srv://u:p@cluster0.example.net'];
    process.env.CONNECTION_AT_KEY = secretValues[0];
    process.env.SMTP_PASS = secretValues[1];
    const file = parsed();
    const entries = unzip(buildKit(file, attachmentsOf(file)));
    const names = [...entries.keys()];
    for (const name of ['README.md', 'company.json', '.env.example', 'Dockerfile', 'docker-compose.yml', 'Caddyfile', 'deploy/kit.env', 'deploy/backup.sh', 'files/logo.png', 'data/vehicles.csv']) {
      assert.ok(names.includes(`acme-haulage-kit/${name}`), `${name} is in the kit`);
    }
    assert.deepEqual(entries.get('acme-haulage-kit/files/logo.png'), readFileSync(join(FIXTURE, 'files/logo.png')), 'files byte for byte');
    assert.deepEqual(JSON.parse(entries.get('acme-haulage-kit/company.json')!.toString()), file);
    for (const [name, body] of entries) for (const v of secretValues) assert.ok(!body.includes(v), `${name} holds no secret value`);
    const envFile = entries.get('acme-haulage-kit/.env.example')!.toString();
    assert.match(envFile, /# SECRET\. Africa's Talking: API key\.\nCONNECTION_AT_KEY=\n/);
    assert.match(envFile, /\nJWT_SECRET=\n/);
    assert.match(envFile, /\nSMTP_FROM="Acme Fleet <fleet@acme-haulage\.example>"\n/);
    const readme = entries.get('acme-haulage-kit/README.md')!.toString();
    assert.match(readme, /docker compose up -d/);
    assert.match(readme, /CONNECTION_AT_KEY/);
    delete process.env.CONNECTION_AT_KEY;
    delete process.env.SMTP_PASS;
  });

  test('the settings template lists every server setting', () => {
    const template = envTemplate(parsed());
    for (const key of Object.keys(envSchema.in.shape)) assert.match(template, new RegExp(`^#? ?${key}[= ]`, 'm'), `${key} is in .env.example`);
  });

  test('each target gets its own script; the untested ones say so', () => {
    for (const [target, extra, script] of [
      ['gcp', { projectId: 'acme-fleet-prod', domainMode: 'none' }, 'deploy/gcp.sh'],
      ['aws', {}, 'deploy/aws.sh'], ['azure', {}, 'deploy/azure.sh'], ['render', {}, 'deploy/render.sh'], ['fly', {}, 'deploy/fly.sh'], ['railway', {}, 'deploy/railway.sh'],
    ] as const) {
      const raw = fixture();
      raw.deploy = { target, domain: 'fleet.acme-haulage.example', image: raw.deploy.image, smtp: raw.deploy.smtp, ...extra };
      if (target === 'aws') raw.connections.push({ code: 'FILES', name: 'S3', kind: 'storage', provider: 's3', enabled: true, settings: { bucket: 'acme-files' }, secrets: { accessKeyId: 'CONNECTION_S3_ID', secretAccessKey: 'CONNECTION_S3_SECRET' } });
      const file = parsed(raw);
      assert.deepEqual(checkKit(file, attachmentsOf(file)), [], target);
      const entries = unzip(buildKit(file, attachmentsOf(file)));
      assert.ok(entries.has(`acme-haulage-kit/${script}`), `${target}: ${script}`);
      const readme = entries.get('acme-haulage-kit/README.md')!.toString();
      assert.equal(/Not yet tested in CI/.test(readme), !['gcp', 'compose'].includes(target), `${target}: tested or not`);
      if (target === 'gcp') assert.match(entries.get('acme-haulage-kit/deploy/kit.env')!.toString(), /PROJECT_ID=acme-fleet-prod/);
    }
  });

  test('problems a file can\'t show on its own: missing files, no lasting storage, no address, no e-mail', () => {
    const file = parsed();
    assert.deepEqual(checkKit(file, new Map()).map((p) => p.split(':')[0]), ['brand.files.logo', 'data.files.0', 'data.files.1', 'data.files.2', 'data.files.3', 'data.files.4']);
    const aws = parsed({ ...fixture(), deploy: { target: 'aws', smtp: fixture().deploy.smtp } });
    assert.ok(checkKit(aws, attachmentsOf(aws)).some((p) => /deploy\.image/.test(p)));
    assert.ok(checkKit(aws, attachmentsOf(aws)).some((p) => /storage connection/.test(p)));
    assert.ok(checkKit(aws, attachmentsOf(aws)).some((p) => /deploy\.domain/.test(p)));
    const noMail = parsed({ ...fixture(), deploy: { target: 'compose', domain: 'fleet.acme-haulage.example', image: 'registry.example.com/fleet/fleet-erp' } });
    assert.ok(checkKit(noMail, attachmentsOf(noMail)).some((p) => /deploy\.smtp/.test(p)));
  });

  test('npm run kit writes the zip, or lists the problems and fails', () => {
    const out = mkdtempSync(join(tmpdir(), 'fleet-kit-out-'));
    const run = (path: string) => spawnSync(process.execPath, ['--import', 'tsx', 'src/jobs/kit.ts', path, '--out', out], { encoding: 'utf8', env: { ...process.env, LOG_LEVEL: 'silent' } });
    const ok = run(join(FIXTURE, 'company.json'));
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(existsSync(join(out, 'acme-haulage-kit.zip')));
    const broken = copyKit();
    rmSync(join(broken, 'data', 'vehicles.csv'));
    rewrite(broken, (f) => { f.deploy.domain = 'not a domain'; });
    const bad = run(join(broken, 'company.json'));
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /deploy\.domain/);
  });
});

describe('applying the company file on start', () => {
  beforeEach(async () => {
    await resetDatabase();
    clearMail();
  });

  test('a fresh installation becomes the company: details, brand, areas, data, roles, connections, people', async () => {
    const { applied, results } = await applyCompanyFile(join(FIXTURE, 'company.json'));
    assert.ok(applied);
    assert.deepEqual(results.filter((r) => r.outcome === 'failed'), []);
    const company = await Company.findOne().lean<Record<string, any>>();
    assert.equal(company!.legalName, 'Acme Haulage Ltd');
    assert.equal(company!.brand.productName, 'Acme Fleet');
    assert.equal(company!.brand.accent, '#7a2e1d');
    assert.ok(await StoredFile.exists({ _id: company!.brand.logoFileId, mime: 'image/png' }), 'the logo is stored');
    assert.deepEqual(company!.modules, ['masters', 'trips', 'finance', 'tracking']);
    assert.equal(company!.operations.roadDistanceFactor, 1.3);
    assert.equal(company!.timezone, 'Africa/Lusaka');
    const zmw = await getMaster('currencies')!.model.findOne({ code: 'ZMW' }).lean<{ _id: unknown }>();
    assert.equal(String(company!.baseCurrencyId), String(zmw!._id), 'the base currency by its code, after the data');
    assert.equal(await count('vehicles'), 2);
    assert.ok(await getMaster('vehicles')!.model.exists({ code: 'T01', registrationNumber: 'ABC 1234' }));
    assert.ok(await Role.exists({ key: 'dispatcher', isSystem: false }));
    const sms = await Connection.findOne({ code: 'SMS' }).lean<Record<string, any>>();
    assert.deepEqual([sms!.provider, sms!.enabled, sms!.secrets.apiKey], ['africastalking', true, 'CONNECTION_AT_KEY']);
    const owner = await User.findOne({ email: 'grace@acme-haulage.example' }).lean<Record<string, any>>();
    assert.equal(owner!.name, 'Grace Banda');
    const ownerRole = await Role.findOne({ key: 'owner' }).lean<{ _id: unknown }>();
    assert.ok(owner!.roleIds.map(String).includes(String(ownerRole!._id)));
    const staff = await User.findOne({ email: 'peter@acme-haulage.example' }).lean<Record<string, any>>();
    const dispatcher = await Role.findOne({ key: 'dispatcher' }).lean<{ _id: unknown }>();
    assert.deepEqual(staff!.roleIds.map(String), [String(dispatcher!._id)]);
    // Invited after the brand was set, so the e-mails carry it.
    const subjects = recentMail().map((m) => `${m.to}: ${m.subject}`);
    assert.ok(subjects.includes('grace@acme-haulage.example: You have been invited to Acme Fleet'), subjects.join(' | '));
    assert.ok(subjects.includes('peter@acme-haulage.example: You have been invited to Acme Fleet'), subjects.join(' | '));
  });

  test('again with nothing changed: nothing is done', async () => {
    await applyCompanyFile(join(FIXTURE, 'company.json'));
    const before = await Company.findOne().select('version').lean<{ version: number }>();
    clearMail();
    assert.equal((await applyCompanyFile(join(FIXTURE, 'company.json'))).applied, false);
    assert.equal((await Company.findOne().select('version').lean<{ version: number }>())!.version, before!.version);
    assert.equal(recentMail().length, 0, 'nobody invited twice');
  });

  test('again with changes: only what the file changed; edits made in the app stay; nothing deleted or duplicated', async () => {
    const dir = copyKit();
    await applyCompanyFile(join(dir, 'company.json'));
    // Someone changes things in the app after the first start.
    const c = await Company.findOne().lean<{ version: number }>();
    await saveCompany({ tradingName: 'Acme (changed in the app)', brand: { emailSenderName: 'Ops desk' }, version: c!.version });
    await Role.updateOne({ key: 'dispatcher' }, { $set: { description: 'Changed in the app' } });

    rewrite(dir, (f) => {
      f.brand.accent = '#204060';
      f.roles[0].name = 'Trip dispatcher';
      f.connections = [];
      f.staff.push({ name: 'Mary Mwale', email: 'mary@acme-haulage.example', roles: ['dispatcher'] });
    });
    writeFileSync(join(dir, 'data', 'vehicles.csv'), `${readFileSync(join(dir, 'data', 'vehicles.csv'), 'utf8')}T03;ABC 9999;MAN;TANKER;5000\r\n`);
    const { applied, results } = await applyCompanyFile(join(dir, 'company.json'));
    assert.ok(applied);
    const company = await Company.findOne().lean<Record<string, any>>();
    assert.equal(company!.brand.accent, '#204060', 'the file changed the colour');
    assert.equal(company!.tradingName, 'Acme (changed in the app)', 'the app\'s edit stays: the file did not change it');
    assert.equal(company!.brand.emailSenderName, 'Ops desk');
    const dispatcher = await Role.findOne({ key: 'dispatcher' }).lean<Record<string, any>>();
    assert.deepEqual([dispatcher!.name, dispatcher!.description], ['Trip dispatcher', 'Changed in the app']);
    assert.ok(await Connection.exists({ code: 'SMS' }), 'a connection left out of the file is not deleted');
    assert.equal(await count('vehicles'), 3, 'the new row added, the others not again');
    assert.equal(await count('currencies'), 2);
    assert.ok(await User.exists({ email: 'mary@acme-haulage.example' }));
    assert.equal(await User.countDocuments({ email: 'peter@acme-haulage.example' }), 1);
    assert.ok(results.some((r) => r.step === 'data data/currencies.csv' && r.outcome === 'unchanged'), 'an unchanged data file is not read again');
  });

  test('a file that is not valid stops the start, naming each problem', async () => {
    const dir = copyKit();
    rewrite(dir, (f) => { f.company.key = 'Acme!'; f.connections[0].secrets.apiKey = 'live-key-value'; });
    await assert.rejects(applyCompanyFile(join(dir, 'company.json')), (err: Error) => /company\.key/.test(err.message) && /connections\.0\.secrets\.apiKey/.test(err.message));
    await assert.rejects(readCompanyFile(join(FIXTURE, 'nope.json')));
  });

  test('a data row the import refuses is reported, and the rest still goes in', async () => {
    const dir = copyKit();
    writeFileSync(join(dir, 'data', 'vehicles.csv'), 'Code *;Registration number *;Make *;Vehicle type *\r\nT01;ABC 1234;Volvo;TANKER\r\nT09;ABC 0009;Volvo;NO-SUCH-TYPE\r\n');
    const { results } = await applyCompanyFile(join(dir, 'company.json'));
    const vehicles = results.find((r) => r.step === 'data data/vehicles.csv')!;
    assert.match(vehicles.detail ?? '', /1 added, 0 already there, 1 refused \(row 3/);
    assert.equal(await count('vehicles'), 1);
  });
});

describe('the Company kit screen\'s API', () => {
  let owner: Session;
  beforeEach(async () => {
    await resetDatabase();
    owner = await signUp('Owner');
    await applyCompanyFile(join(FIXTURE, 'company.json'));
  });

  test('this installation as a company file, with its brand files', async () => {
    const data = (await api().get('/api/v1/setup-kit').set(bearer(owner)).expect(200)).body.data;
    assert.equal(data.file.company.key, 'acme-haulage');
    assert.deepEqual([data.file.regional.country, data.file.regional.baseCurrency], ['ZM', 'ZMW']);
    assert.equal(data.file.brand.files.logo, 'files/logo.png');
    const logo = data.attachments.find((a: { path: string }) => a.path === 'files/logo.png');
    assert.deepEqual(Buffer.from(logo.data, 'base64'), readFileSync(join(FIXTURE, 'files/logo.png')));
    assert.deepEqual(data.file.roles.map((r: { key: string }) => r.key), ['dispatcher']);
    assert.equal(data.file.connections[0].secrets.apiKey, 'CONNECTION_AT_KEY');
    assert.ok(data.targets.some((t: { key: string; tested: boolean }) => t.key === 'compose' && t.tested));
    assert.ok(data.masters.some((m: { key: string }) => m.key === 'vehicles'));
    assert.equal(data.lastApplied.company, 'acme-haulage');
  });

  test('checks a file and builds its kit; problems come back with where they are', async () => {
    const file = fixture();
    const attachments = [...attachmentsOf(parsed())].map(([path, v]) => ({ path, data: v.toString('base64') }));
    const checked = (await api().post('/api/v1/setup-kit/check').set(bearer(owner)).send({ file: { ...file, deploy: { target: 'compose', image: 'registry.example.com/fleet/fleet-erp' } }, attachments }).expect(200)).body.data;
    assert.equal(checked.ok, false);
    assert.deepEqual(checked.problems.map((p: { path: string }) => p.path).sort(), ['deploy.domain', 'deploy.smtp']);
    const res = await api().post('/api/v1/setup-kit/kit').set(bearer(owner)).send({ file, attachments }).buffer(true).parse((r, done) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => done(null, Buffer.concat(chunks)));
    }).expect(200);
    assert.equal(res.headers['content-type'], 'application/zip');
    assert.match(String(res.headers['content-disposition']), /acme-haulage-kit\.zip/);
    assert.ok(unzip(res.body as Buffer).has('acme-haulage-kit/data/vehicles.csv'));
    const bad = await api().post('/api/v1/setup-kit/kit').set(bearer(owner)).send({ file: { ...file, format: 9 }, attachments: [] }).expect(422);
    assert.match(JSON.stringify(bad.body), /format/);
  });

  test('only someone who may change the company can use it', async () => {
    const viewer = await userWithRole(owner, 'viewer');
    await api().get('/api/v1/setup-kit').set(bearer(viewer)).expect(403);
    await api().get('/api/v1/setup-kit').expect(401);
  });
});
