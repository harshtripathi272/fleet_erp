// #96: "Set up a company": its draft, what it checks, setting up this copy, a demonstration's sign-ins, and clearing.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { env } from '../src/config/env.js';
import { getMaster } from '../src/core/masters/registry.js';
import { ensureFirstOwner } from '../src/modules/auth/auth.service.js';
import { Company } from '../src/modules/company/company.model.js';
import { applyCompanyFile } from '../src/modules/setup/apply.js';
import { unzip } from '../src/modules/setup/zip.js';
import { User } from '../src/modules/users/user.model.js';
import { api, bearer, resetDatabase, signUp, startDatabase, stopDatabase, userWithRole, type Session } from './helpers.js';

env.FILE_STORAGE_DIR = mkdtempSync(join(tmpdir(), 'fleet-files-'));
before(startDatabase);
after(stopDatabase);

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64').toString('base64');
const file = (over: Record<string, unknown> = {}) => ({
  format: 1, purpose: 'real',
  company: { key: 'acme-haulage', legalName: 'Acme Haulage Limited', tradingName: 'Acme Haulage' },
  regional: { country: 'IN', baseCurrency: 'INR', timezone: 'Asia/Kolkata', dateFormat: 'DD/MM/YYYY', style: { timeFormat: '12h', phoneCountryCode: '+91' } },
  brand: { accent: '#14406b', files: {} },
  owner: { email: 'owner@acme.example' },
  staff: [], connections: [], roles: [], selfSignUp: false,
  data: { sample: 'none', files: [] },
  deploy: { target: 'compose' },
  ...over,
});

/** Sets up this copy; each line of the answer, as the screen reads them. */
async function apply(session: Session, body: Record<string, unknown>) {
  const res = await api().post('/api/v1/setup-kit/apply').set(bearer(session)).send(body).buffer(true)
    .parse((r, done) => { let text = ''; r.setEncoding('utf8'); r.on('data', (c: string) => { text += c; }); r.on('end', () => done(null, text)); });
  assert.equal(res.status, 200);
  return String(res.body).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
}
const endOf = (lines: Record<string, any>[]) => lines.at(-1)!;
const count = (master: string, filter: Record<string, unknown> = {}) => getMaster(master)!.model.countDocuments(filter);

describe('Set up a company', () => {
  let owner: Session;
  beforeEach(async () => {
    await resetDatabase();
    owner = await signUp('First Owner');
    env.NODE_ENV = 'test';
    env.SETUP_PACKAGES = true;
  });

  test('the draft keeps the answers and each file, until it is thrown away', async () => {
    const empty = (await api().get('/api/v1/setup-kit/draft').set(bearer(owner)).expect(200)).body.data;
    assert.equal(empty.draft, null);
    await api().put('/api/v1/setup-kit/draft').set(bearer(owner)).send({ file: file(), step: 'brand', visited: ['start', 'company'], finish: 'package' }).expect(200);
    await api().put('/api/v1/setup-kit/draft/file').set(bearer(owner)).send({ path: 'files/logo.png', data: PNG }).expect(200);
    const saved = (await api().get('/api/v1/setup-kit/draft').set(bearer(owner)).expect(200)).body.data;
    assert.equal(saved.draft.step, 'brand');
    assert.equal(saved.draft.file.company.legalName, 'Acme Haulage Limited');
    assert.deepEqual(saved.attachments, [{ path: 'files/logo.png', data: PNG }]);
    await api().post('/api/v1/setup-kit/draft/file/remove').set(bearer(owner)).send({ path: 'files/logo.png' }).expect(200);
    await api().delete('/api/v1/setup-kit/draft').set(bearer(owner)).expect(200);
    assert.equal((await api().get('/api/v1/setup-kit/draft').set(bearer(owner))).body.data.draft, null);
  });

  test('only someone who may change the company can open it, and only someone who may also make accounts can finish', async () => {
    const viewer = await userWithRole(owner, 'viewer');
    await api().get('/api/v1/setup-kit/draft').set(bearer(viewer)).expect(403);
    await api().put('/api/v1/setup-kit/draft').set(bearer(viewer)).send({ file: file() }).expect(403);
    await api().post('/api/v1/setup-kit/apply').set(bearer(viewer)).send({ file: file() }).expect(403);
    await api().get('/api/v1/setup-kit/draft').expect(401);
    assert.equal(await Company.countDocuments(), 0);
  });

  test('country and currency are asked for; set up here, nothing about deploying can be wrong', async () => {
    const check = async (body: Record<string, unknown>) => (await api().post('/api/v1/setup-kit/check').set(bearer(owner)).send(body).expect(200)).body.data.problems.map((p: { path: string }) => p.path);
    const missing = await check({ file: file({ regional: {} }), finish: 'here' });
    assert.deepEqual(missing.sort(), ['regional.baseCurrency', 'regional.country']);
    assert.deepEqual(await check({ file: file(), finish: 'here' }), [], 'no image, domain or e-mail server needed here');
    const packaged = await check({ file: file(), finish: 'package' });
    assert.ok(packaged.includes('deploy.image'), packaged.join());
    assert.ok(!packaged.includes('deploy.smtp'), 'e-mail is optional: the first owner can have a password instead');
  });

  test('sets up this copy: details, country and currency from their codes, brand, words and regional style', async () => {
    const lines = await apply(owner, { file: file({
      areas: ['masters', 'trips'],
      workspace: { vocabulary: { trip: { singular: 'Job', plural: 'Jobs' } } },
      operations: { settlementPeriod: 'monthly' },
    }) });
    assert.equal(endOf(lines).type, 'done', JSON.stringify(lines));
    assert.ok(!lines.some((l) => l.outcome === 'failed'), JSON.stringify(lines));
    assert.ok(lines.some((l) => l.step === 'currency INR' && l.outcome === 'created'));
    assert.ok(lines.some((l) => l.step === 'country IN' && l.outcome === 'created'));
    const currency = await getMaster('currencies')!.model.findOne({ code: 'INR' }).lean<Record<string, any>>();
    assert.equal(currency!.minorUnits, 2);
    const country = await getMaster('countries')!.model.findOne({ code: 'IN' }).lean<Record<string, any>>();
    assert.equal(country!.name, 'India');
    assert.equal(country!.dialCode, '+91');
    const company = await Company.findOne().lean<Record<string, any>>();
    assert.equal(company!.legalName, 'Acme Haulage Limited');
    assert.equal(String(company!.baseCurrencyId), String(currency!._id));
    assert.equal(company!.regional.timeFormat, '12h');
    assert.equal(company!.vocabulary.trip.singular, 'Job');
    assert.equal(company!.operations.settlementPeriod, 'monthly');
    assert.deepEqual([...company!.modules].sort(), ['masters', 'trips']);
    const status = (await api().get('/api/v1/setup-kit/status').set(bearer(owner)).expect(200)).body.data;
    assert.equal(status.finished, true);
  });

  test('an owner named in the set-up who has no account is invited; running it again changes nothing', async () => {
    await apply(owner, { file: file() });
    const invited = await User.findOne({ email: 'owner@acme.example' }).lean<Record<string, any>>();
    assert.ok(invited, 'invited');
    const again = await apply(owner, { file: file() });
    assert.equal(endOf(again).applied, false);
    assert.equal(await User.countDocuments({ email: 'owner@acme.example' }), 1);
  });

  test('a demonstration loads its sample with the company made first, and gets one sign-in per role that works', async () => {
    const lines = await apply(owner, { file: file({ purpose: 'demo', regional: { country: 'ZM', baseCurrency: 'ZMW', timezone: 'Africa/Lusaka' }, data: { sample: 'small', files: [] } }) });
    const end = endOf(lines);
    assert.equal(end.type, 'done', JSON.stringify(lines));
    assert.ok(lines.some((l) => l.step === 'sample data' && l.outcome === 'created'), JSON.stringify(lines));
    assert.ok((await count('vehicles')) > 0);
    assert.equal((await Company.findOne().lean<Record<string, any>>())!.legalName, 'Acme Haulage Limited', 'not the sample\'s company');
    const logins = end.logins as { role: string; login: string; password: string }[];
    assert.deepEqual(logins.slice(0, 3).map((l) => l.login), ['operations@acme-haulage.test', 'finance@acme-haulage.test', 'viewer@acme-haulage.test']);
    assert.ok(logins.some((l) => l.role.startsWith('Driver')), 'and a driver');
    await api().post('/api/v1/auth/login').send({ email: logins[0]!.login, password: logins[0]!.password }).expect(200);
    await api().post('/api/v1/auth/login').send({ phone: logins.at(-1)!.login, password: logins.at(-1)!.password }).expect(200);
    // The passwords are in that one answer only.
    const draft = JSON.stringify((await api().get('/api/v1/setup-kit/draft').set(bearer(owner))).body.data);
    assert.ok(!draft.includes(logins[0]!.password));
  });

  test('a real company gets no made-up sign-ins', async () => {
    const end = endOf(await apply(owner, { file: file() }));
    assert.deepEqual(end.logins, []);
    assert.equal(await User.countDocuments({ email: 'operations@acme-haulage.test' }), 0);
  });

  test('clearing asks for the company\'s name, keeps the person doing it, and is refused on a real company in production', async () => {
    await apply(owner, { file: file({ purpose: 'demo', data: { sample: 'small', files: [] }, regional: { country: 'ZM', baseCurrency: 'ZMW' } }) });
    assert.ok((await count('vehicles')) > 0);
    const wrong = endOf(await apply(owner, { file: file(), clear: { confirm: 'something else' } }));
    assert.equal(wrong.type, 'error');
    assert.match(wrong.message, /Type the company's name/);
    assert.ok((await count('vehicles')) > 0, 'nothing removed');

    const right = await apply(owner, { file: file({ company: { key: 'second-co', legalName: 'Second Company' } }), clear: { confirm: 'acme haulage' } });
    assert.equal(endOf(right).type, 'done', JSON.stringify(right));
    assert.equal(await count('vehicles'), 0);
    assert.ok(await User.exists({ _id: owner.userId }), 'the person doing it stays');
    assert.equal(await User.countDocuments({ email: 'operations@acme-haulage.test' }), 0);
    assert.equal((await Company.findOne().lean<Record<string, any>>())!.legalName, 'Second Company');

    env.NODE_ENV = 'production';
    const refused = endOf(await apply(owner, { file: file({ company: { key: 'second-co', legalName: 'Second Company' } }), clear: { confirm: 'Second Company' } }));
    assert.equal(refused.type, 'error');
    assert.match(refused.message, /real company/);
    assert.equal((await api().get('/api/v1/setup-kit').set(bearer(owner)).expect(200)).body.data.canClear, false);
  });

  test('a package is built from the draft\'s files, and a copy can be told not to make packages', async () => {
    const pkg = file({ purpose: 'demo', brand: { files: { logo: 'files/logo.png' } }, deploy: { target: 'compose', image: 'ghcr.io/acme/fleet-erp', domain: 'fleet.acme.example', smtp: { host: 'smtp.acme.example', from: 'Acme <fleet@acme.example>' } } });
    await api().put('/api/v1/setup-kit/draft/file').set(bearer(owner)).send({ path: 'files/logo.png', data: PNG }).expect(200);
    const checked = (await api().post('/api/v1/setup-kit/check').set(bearer(owner)).send({ file: pkg, finish: 'package' }).expect(200)).body.data;
    assert.deepEqual(checked.problems, []);
    const res = await api().post('/api/v1/setup-kit/kit').set(bearer(owner)).send({ file: pkg, attachments: [] }).buffer(true)
      .parse((r, done) => { const chunks: Buffer[] = []; r.on('data', (c: Buffer) => chunks.push(c)); r.on('end', () => done(null, Buffer.concat(chunks))); }).expect(200);
    assert.equal(res.headers['content-type'], 'application/zip');
    assert.ok((res.body as Buffer).includes(Buffer.from('files/logo.png')), 'the logo is in it');
    env.SETUP_PACKAGES = false;
    await api().post('/api/v1/setup-kit/kit').set(bearer(owner)).send({ file: pkg, attachments: [] }).expect(403);
    assert.equal((await api().get('/api/v1/setup-kit').set(bearer(owner))).body.data.packages, false);
  });

  const shaped = () => ({
    layouts: [{ entity: 'drivers', master: { label: 'Operators' }, sections: ['Union'], fields: [{ path: 'phone', label: 'Mobile', section: 'Union' }], choices: [] }],
    lists: [{ code: 'CLASSES', name: 'Licence classes', values: [{ value: 'a', label: 'Class A' }, { value: 'b', label: 'Class B' }] }],
    fields: [
      { entity: 'drivers', key: 'unionCard', label: 'Union card', type: 'text', required: false },
      { entity: 'drivers', key: 'licenceClass', label: 'Licence class', type: 'select', listCode: 'CLASSES' },
      { entity: 'trips', key: 'sealNumber', label: 'Seal number', type: 'text', placement: 'dispatch', askedOf: 'driver' },
    ],
    customMasters: [{ code: 'road-permits', name: 'Road permits', titleField: 'number', fields: [{ key: 'number', label: 'Number', type: 'text', required: true }, { key: 'expires', label: 'Expires', type: 'date' }] }],
  });
  const meta = async (session: Session) => (await api().get('/api/v1/meta/masters').set(bearer(session)).expect(200)).body.data as Record<string, any>[];

  test('the masters in the file become the company\'s system: names, its own fields and its own masters, and applying again changes nothing', async () => {
    const lines = await apply(owner, { file: file({ masters: shaped() }) });
    assert.equal(endOf(lines).type, 'done', JSON.stringify(lines));
    assert.ok(!lines.some((l) => l.outcome === 'failed'), JSON.stringify(lines));
    const drivers = (await meta(owner)).find((d) => d.key === 'drivers')!;
    assert.equal(drivers.label, 'Operators');
    assert.deepEqual(drivers.sections, ['Union']);
    assert.equal(drivers.fields.find((f: { path: string }) => f.path === 'phone').label, 'Mobile');
    const own = drivers.customFields as { key: string; choices?: unknown[] }[];
    assert.deepEqual(own.map((f) => f.key).sort(), ['licenceClass', 'unionCard']);
    assert.equal(own.find((f) => f.key === 'licenceClass')!.choices!.length, 2, 'the list is joined up by its code');
    const customs = (await api().get('/api/v1/custom-masters').set(bearer(owner)).expect(200)).body.data as { code: string }[];
    assert.deepEqual(customs.map((c) => c.code), ['road-permits']);
    const again = await apply(owner, { file: file({ masters: shaped() }) });
    assert.equal(endOf(again).applied, false);
  });

  test('a whole company goes through a package to an empty copy: settings, masters, records and links', async () => {
    await apply(owner, { file: file({ purpose: 'demo', masters: shaped(), regional: { country: 'ZM', baseCurrency: 'ZMW', currencies: ['USD'] }, data: { sample: 'small', files: [] } }) });
    const capture = (await api().get('/api/v1/setup-kit').set(bearer(owner)).expect(200)).body.data;
    assert.ok(capture.capture.masters > 0, 'it counts what would go');
    assert.equal(capture.file.masters.customMasters.some((m: { code: string }) => m.code === 'road-permits'), true, 'this copy is read as a file');
    const ids = new Set((await getMaster('vehicles')!.model.find().select('_id').lean()).map((v) => String(v._id)));
    const pkg = { ...capture.file, deploy: { target: 'gcp', projectId: 'acme-fleet-prod', domainMode: 'none', smtp: { host: 'smtp.acme.example', from: 'Acme <fleet@acme.example>' } } };
    const zipped = await api().post('/api/v1/setup-kit/package').set(bearer(owner)).send({ file: pkg, include: { records: 'masters', files: false } }).buffer(true)
      .parse((r, done) => { const chunks: Buffer[] = []; r.on('data', (c: Buffer) => chunks.push(c)); r.on('end', () => done(null, Buffer.concat(chunks))); }).expect(200);
    const dir = mkdtempSync(join(tmpdir(), 'fleet-pkg-'));
    const entries = unzip(zipped.body as Buffer);
    for (const [path, body] of entries) {
      const at = join(dir, path);
      mkdirSync(dirname(at), { recursive: true });
      writeFileSync(at, body);
    }
    const root = `${pkg.company.key}-kit`;
    assert.ok(entries.has(`${root}/deploy.sh`), 'one command to deploy');
    assert.ok(entries.has(`${root}/app-source.tar.gz`), 'and the app, so nothing else is needed');
    const carried = JSON.parse(entries.get(`${root}/company.json`)!.toString());
    assert.equal(carried.data.snapshot, 'data/snapshot.json');
    assert.ok(!entries.get(`${root}/.env.example`)!.toString().match(/^MONGODB_URI=.+$/m), 'no secret is filled in');

    await resetDatabase();
    const applied = await applyCompanyFile(join(dir, root, 'company.json'));
    assert.ok(!applied.results.some((r) => r.outcome === 'failed'), JSON.stringify(applied.results.filter((r) => r.outcome === 'failed')));
    assert.deepEqual(new Set((await getMaster('vehicles')!.model.find().select('_id').lean()).map((v) => String(v._id))), ids, 'the same records, with the same ids, so every link still holds');
    assert.equal((await getMaster('drivers')!.model.countDocuments()) > 0, true);
    assert.equal((await Company.findOne().lean<Record<string, any>>())!.legalName, 'Acme Haulage Limited');
    const custom = await getMaster('custom-masters')!.model.findOne({ code: 'road-permits' }).lean();
    assert.ok(custom, 'its own master came along');
  });

  test('the guide lists each secret with where to get it and the steps with this company\'s values, and never holds a value', async () => {
    const pkg = file({ connections: [{ code: 'SMS', name: 'Twilio', kind: 'sms', provider: 'twilio', enabled: true, settings: { accountSid: 'AC0123456789abcdef0123456789abcdef', from: '+15551234567' }, secrets: { authToken: 'CONNECTION_SMS_AUTHTOKEN' } }], deploy: { target: 'gcp', projectId: 'acme-fleet-prod', domain: 'fleet.acme.example', domainMode: 'lb', smtp: { host: 'smtp.acme.example', user: 'fleet', from: 'Acme <fleet@acme.example>' } } });
    const guide = (await api().post('/api/v1/setup-kit/guide').set(bearer(owner)).send({ file: pkg }).expect(200)).body.data;
    assert.deepEqual(guide.problems, []);
    const secret = (name: string) => guide.env.find((v: { name: string; secret: boolean }) => v.name === name && v.secret);
    assert.match(secret('MONGODB_URI').where, /Atlas/);
    assert.match(secret('MONGODB_URI').command, /gcloud secrets create acme-haulage-mongodb-uri .*--project acme-fleet-prod/);
    assert.equal(secret('JWT_SECRET').automatic, true, 'made by the script');
    assert.ok(secret('SMTP_PASS'));
    assert.ok(secret('CONNECTION_SMS_AUTHTOKEN'));
    assert.ok(guide.env.filter((v: { secret: boolean }) => v.secret).every((v: { value?: string }) => v.value === undefined), 'no secret has a value');
    const text = JSON.stringify(guide.steps);
    assert.match(text, /cloudshell=true&project=acme-fleet-prod/);
    assert.match(text, /\.\/deploy\.sh/);
    assert.match(text, /fleet\.acme\.example/);
  });

  test('rates can be previewed live from a service with no key, and fetched for the company\'s currencies when it\'s set up', async () => {
    const realFetch = globalThis.fetch;
    let asked = '';
    globalThis.fetch = (async (url: string) => {
      asked = String(url);
      return new Response(JSON.stringify({ result: 'success', rates: { USD: 0.05, EUR: 0.04 }, time_last_update_unix: 1793923351 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const preview = (await api().post('/api/v1/setup-kit/rates-preview').set(bearer(owner)).send({ provider: 'open-er-api', base: 'ZMW', codes: ['USD', 'EUR', 'XXX'] }).expect(200)).body.data;
      assert.match(asked, /open\.er-api\.com\/v6\/latest\/ZMW/);
      assert.equal(preview.rates.USD, 0.05);
      assert.deepEqual(preview.missing, ['XXX']);
      const keyed = (await api().post('/api/v1/setup-kit/rates-preview').set(bearer(owner)).send({ provider: 'openexchangerates', base: 'ZMW', codes: ['USD'] }).expect(200)).body.data;
      assert.equal(keyed.needsKey, true);
      const lines = await apply(owner, { file: file({ regional: { country: 'ZM', baseCurrency: 'ZMW', timezone: 'Africa/Lusaka', currencies: ['USD', 'EUR'] }, connections: [{ code: 'RATES', name: 'Live rates', kind: 'rates', provider: 'open-er-api', enabled: true }] }) });
      assert.ok(lines.some((l) => l.step === 'exchange rates' && l.outcome === 'created'), JSON.stringify(lines));
      assert.equal(await count('currencies', { code: 'EUR' }), 1);
      assert.ok((await count('exchange-rates', { source: 'feed' })) >= 2);
    } finally { globalThis.fetch = realFetch; }
  });

  test('with no e-mail server the guide asks for OWNER_PASSWORD, which makes the first owner and can never change them afterwards', async () => {
    const noMail = file({ deploy: { target: 'gcp', projectId: 'acme-fleet-prod', domainMode: 'none' } });
    const guide = (await api().post('/api/v1/setup-kit/guide').set(bearer(owner)).send({ file: noMail }).expect(200)).body.data;
    const variable = guide.env.find((v: { name: string }) => v.name === 'OWNER_PASSWORD');
    assert.equal(variable.secret, true);
    assert.equal(variable.value, undefined);
    assert.match(guide.envFile, /# SECRET\. The first password for owner@acme\.example/);
    assert.doesNotMatch(guide.envFile, /^SMTP_FROM=/m, 'an empty one would stop the server starting');
    assert.match(JSON.stringify(guide.steps), /Sign in as owner@acme\.example with OWNER_PASSWORD/);

    const withMail = file({ deploy: { target: 'gcp', projectId: 'acme-fleet-prod', domainMode: 'none', smtp: { host: 'smtp.acme.example', from: 'Acme <fleet@acme.example>' } } });
    const mailed = (await api().post('/api/v1/setup-kit/guide').set(bearer(owner)).send({ file: withMail }).expect(200)).body.data;
    assert.ok(!mailed.env.some((v: { name: string }) => v.name === 'OWNER_PASSWORD'), 'not asked for when e-mail can do it');

    await resetDatabase();
    env.OWNER_PASSWORD = 'First-Owner-2026';
    try {
      const made = await ensureFirstOwner('first@acme.example');
      assert.deepEqual(made, { created: true, sent: false, passwordSet: true });
      await api().post('/api/v1/auth/login').send({ email: 'first@acme.example', password: 'First-Owner-2026' }).expect(200);
      // Someone changing the variable later can't take the account over.
      env.OWNER_PASSWORD = 'Another-Pass-2026';
      assert.equal((await ensureFirstOwner('first@acme.example')).created, false);
      await api().post('/api/v1/auth/login').send({ email: 'first@acme.example', password: 'Another-Pass-2026' }).expect(401);
      await api().post('/api/v1/auth/login').send({ email: 'first@acme.example', password: 'First-Owner-2026' }).expect(200);
    } finally { env.OWNER_PASSWORD = undefined; }
  });

  test('a short name too long for Google Cloud is caught before anything is deployed', async () => {
    const long = file({ company: { key: 'copperbelt-haulage-limited', legalName: 'Copperbelt Haulage Limited' }, deploy: { target: 'gcp', projectId: 'acme-fleet-prod', domainMode: 'none' } });
    const problems = (await api().post('/api/v1/setup-kit/check').set(bearer(owner)).send({ file: long, finish: 'package' }).expect(200)).body.data.problems as { path: string; message: string }[];
    assert.ok(problems.some((p) => p.path === 'company.key' && /at most 24/.test(p.message)), JSON.stringify(problems));
  });
});
