import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { env } from '../src/config/env.js';
import { User } from '../src/modules/users/user.model.js';
import { api, bearer, resetDatabase, signUp, startDatabase, stopDatabase, type Session } from './helpers.js';

/** The masters and set-up findings from the second #102 walk: a liquids-only company, a product's form, staff with no e-mail. */
before(startDatabase);
after(stopDatabase);

const file = (over: Record<string, unknown> = {}) => ({
  format: 1, purpose: 'real',
  company: { key: 'kilipetro', legalName: 'Kilimanjaro Petroleum Haulage', tradingName: 'KiliPetro' },
  regional: { country: 'TZ', baseCurrency: 'TZS', timezone: 'Africa/Dar_es_Salaam' },
  brand: { files: {} }, owner: { email: 'owner@kilipetro.example' },
  staff: [], connections: [], roles: [], selfSignUp: false,
  data: { sample: 'starter', files: [] }, deploy: { target: 'compose' },
  ...over,
});
async function apply(session: Session, body: Record<string, unknown>) {
  const res = await api().post('/api/v1/setup-kit/apply').set(bearer(session)).send(body).buffer(true)
    .parse((r, done) => { let text = ''; r.setEncoding('utf8'); r.on('data', (c: string) => { text += c; }); r.on('end', () => done(null, text)); });
  assert.equal(res.status, 200);
  return String(res.body).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
}

describe('a new company\'s masters', () => {
  let owner: Session;
  beforeEach(async () => {
    await resetDatabase();
    owner = await signUp('First Owner');
    env.NODE_ENV = 'test';
    env.COPY_PURPOSE = 'trial';
  });

  test('a liquids-only company starts with fuel in litres at 20 °C, not general cargo in tonnes; and its towns', async () => {
    await apply(owner, { file: file({ operations: { cargoKinds: ['volume'] } }) });
    const products = (await api().get('/api/v1/products').query({ limit: 50 }).set(bearer(owner)).expect(200)).body.data as Record<string, any>[];
    assert.deepEqual(products.map((p) => p.code).sort(), ['DIESEL', 'PETROL']);
    const diesel = products.find((p) => p.code === 'DIESEL')!;
    assert.deepEqual([diesel.volumeCorrected, diesel.referenceTemperatureC, diesel.hazard.unNumber], [true, 20, 'UN1202']);
    const towns = (await api().get('/api/v1/cities').query({ limit: 100 }).set(bearer(owner)).expect(200)).body.data.map((c: { name: string }) => c.name);
    assert.ok(towns.includes('Dar es Salaam') && towns.includes('Mbeya'));
  });

  test('staff added with no e-mail server get a first password, shown once, which they must change', async () => {
    const lines = await apply(owner, { file: file({ staff: [{ name: 'Baraka', email: 'ops@kilipetro.example', roles: ['operations'] }] }) });
    const end = lines.at(-1)!;
    assert.equal(end.logins.length, 1);
    assert.equal(end.logins[0].login, 'ops@kilipetro.example');
    assert.ok(lines.some((l) => l.step === 'staff ops@kilipetro.example' && /no e-mail server/i.test(String(l.detail))), 'Apply says nobody was e-mailed');
    await api().post('/api/v1/auth/login').send({ email: 'ops@kilipetro.example', password: end.logins[0].password }).expect(200);
    assert.equal((await User.findOne({ email: 'ops@kilipetro.example' }).lean())!.mustChangePassword, true);
  });

  test('a UN number can be typed as its four digits, the form says "UN class", and problems name the field', async () => {
    await apply(owner, { file: file() });
    const list = async (key: string) => (await api().get(`/api/v1/${key}`).query({ limit: 50 }).set(bearer(owner)).expect(200)).body.data as Record<string, any>[];
    const group = (await list('product-groups'))[0]!;
    const litre = (await list('units')).find((u) => u.code === 'L')!;
    const made = (await api().post('/api/v1/products').set(bearer(owner)).send({ code: 'JET-A1', name: 'Jet A-1', groupId: group.id, unitId: litre.id, hazard: { unClass: '3', unNumber: '1863' } }).expect(201)).body.data;
    assert.equal(made.hazard.unNumber, 'UN1863');
    const masters = (await api().get('/api/v1/meta/masters').set(bearer(owner)).expect(200)).body.data as Record<string, any>[];
    const fields = masters.find((m) => m.key === 'products')!.fields as { path: string; label: string }[];
    assert.equal(fields.find((f) => f.path === 'hazard.unClass')!.label, 'UN class');
    assert.equal(fields.find((f) => f.path === 'referenceTemperatureC')!.label, 'Reference temperature (°C)');
    const refused = await api().post('/api/v1/products').set(bearer(owner)).send({ code: 'X', name: 'X', groupId: group.id, unitId: litre.id, referenceTemperatureC: 20 }).expect(422);
    assert.ok(JSON.stringify(refused.body.error.details).includes('referenceTemperatureC'), 'the problem is keyed by its field, for the form to mark it');
  });
});
