// #96: "Set up a company": its draft, what it checks, setting up this copy, a demonstration's sign-ins, and clearing.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { env } from '../src/config/env.js';
import { getMaster } from '../src/core/masters/registry.js';
import { Company } from '../src/modules/company/company.model.js';
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
    assert.ok(packaged.includes('deploy.image') && packaged.includes('deploy.smtp'), packaged.join());
    assert.ok(!(await check({ file: file({ purpose: 'demo' }), finish: 'package' })).includes('deploy.smtp'), 'a demonstration needs no e-mail server');
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
    const pkg = file({ purpose: 'demo', brand: { files: { logo: 'files/logo.png' } }, deploy: { target: 'compose', image: 'ghcr.io/acme/fleet-erp', domain: 'fleet.acme.example' } });
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
});
