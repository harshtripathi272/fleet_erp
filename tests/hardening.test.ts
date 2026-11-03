// Production hardening (#18): settings refused in production, headers, sign-in races, the first Owner,
// upload limits, log redaction and the indexes behind the desks' queues.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Writable } from 'node:stream';
import pino from 'pino';
import { env, envSchema } from '../src/config/env.js';
import { REDACT_PATHS } from '../src/core/logger/index.js';
import { clearMail, recentMail } from '../src/core/mail/mailer.js';
import { MemoryRateLimitStore } from '../src/core/rateLimit/index.js';
import { setFileStore, type FileStore } from '../src/core/storage/index.js';
import { ensureFirstOwner } from '../src/modules/auth/auth.service.js';
import { Consignment, DriverDocument } from '../src/modules/operations/models/cargo.model.js';
import { FundRequest } from '../src/modules/operations/models/funding.model.js';
import { Expense } from '../src/modules/operations/models/money.model.js';
import { Trip } from '../src/modules/operations/models/trip.model.js';
import { Role } from '../src/modules/roles/role.model.js';
import { User } from '../src/modules/users/user.model.js';
import { api, bearer, errorCode, resetDatabase, signUp, startDatabase, stopDatabase, uniqueEmail } from './helpers.js';

before(async () => {
  await startDatabase();
  const kept = new Map<string, Buffer>();
  const store: FileStore = { async put(key, body) { kept.set(key, body); }, async open() { throw new Error('not used'); }, async remove(key) { kept.delete(key); } };
  setFileStore(store);
});
after(stopDatabase);
beforeEach(resetDatabase);

/** Settings that pass in production; each case below breaks one of them. */
const prod = {
  NODE_ENV: 'production', SMTP_HOST: 'smtp.mandrillapp.com', JWT_SECRET: 'p'.repeat(40),
  APP_URL: 'https://fleet.example.com', OWNER_EMAIL: 'owner@example.com', TRUST_PROXY: '1',
};
const refusedPaths = (values: Record<string, unknown>) => {
  const r = envSchema.safeParse(values);
  return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
};

describe('production settings', () => {
  test('a complete production configuration is accepted', () => {
    assert.deepEqual(refusedPaths(prod), []);
    assert.deepEqual(refusedPaths({ ...prod, CORS_ORIGINS: 'https://app.example.com, https://ops.example.com/' }), []);
    assert.deepEqual(envSchema.parse({ ...prod, CORS_ORIGINS: 'https://app.example.com/' }).CORS_ORIGINS, ['https://app.example.com']);
    assert.equal(envSchema.parse({ ...prod, OWNER_EMAIL: ' Owner@Example.com ' }).OWNER_EMAIL, 'owner@example.com');
  });

  test('refuses a local or plain-http APP_URL, since password links would point there', () => {
    for (const APP_URL of ['http://127.0.0.1:3000', 'https://localhost', 'http://fleet.example.com']) {
      assert.deepEqual(refusedPaths({ ...prod, APP_URL }), ['APP_URL'], APP_URL);
    }
    assert.deepEqual(refusedPaths({ ...prod, APP_URL: undefined }), ['APP_URL']);
  });

  test('refuses TRUST_PROXY=true, which lets a client pick its own address and slip past rate limits', () => {
    assert.deepEqual(refusedPaths({ ...prod, TRUST_PROXY: 'true' }), ['TRUST_PROXY']);
    assert.deepEqual(refusedPaths({ ...prod, TRUST_PROXY: '2' }), []);
  });

  test('refuses a wildcard, a path or plain http in CORS_ORIGINS', () => {
    assert.deepEqual(refusedPaths({ ...prod, CORS_ORIGINS: '*' }), ['CORS_ORIGINS']);
    assert.deepEqual(refusedPaths({ ...prod, CORS_ORIGINS: 'https://app.example.com/login' }), ['CORS_ORIGINS']);
    assert.deepEqual(refusedPaths({ ...prod, CORS_ORIGINS: 'http://app.example.com' }), ['CORS_ORIGINS']);
    // Outside production a local frontend is fine, a wildcard still is not.
    assert.deepEqual(refusedPaths({ CORS_ORIGINS: 'http://localhost:5173' }), []);
    assert.deepEqual(refusedPaths({ CORS_ORIGINS: '*' }), ['CORS_ORIGINS']);
  });

  test('requires OWNER_EMAIL, so a stranger cannot claim a new installation', () => {
    assert.deepEqual(refusedPaths({ ...prod, OWNER_EMAIL: undefined }), ['OWNER_EMAIL']);
    assert.deepEqual(refusedPaths({ ...prod, OWNER_EMAIL: 'not-an-email' }), ['OWNER_EMAIL']);
  });
});

describe('response headers', () => {
  test('API answers are never cached and carry a permissions policy', async () => {
    const r = await api().get('/api/v1/health').expect(200);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.match(r.headers['permissions-policy']!, /camera=\(\)/);
    assert.equal(r.headers['strict-transport-security'], undefined);
  });

  test('production adds HSTS', async () => {
    const previous = env.NODE_ENV;
    env.NODE_ENV = 'production';
    try {
      const r = await api().get('/api/v1/health').expect(200);
      assert.equal(r.headers['strict-transport-security'], 'max-age=31536000');
    } finally { env.NODE_ENV = previous; }
  });

  test('with allowed origins, every answer varies by Origin so caches keep them apart', async () => {
    env.CORS_ORIGINS = ['https://app.example.com'];
    try {
      const other = await api().get('/api/v1/health').set('Origin', 'https://evil.example').expect(200);
      assert.equal(other.headers['access-control-allow-origin'], undefined);
      assert.match(other.headers.vary!, /Origin/);
      const ok = await api().get('/api/v1/health').set('Origin', 'https://app.example.com').expect(200);
      assert.equal(ok.headers['access-control-allow-origin'], 'https://app.example.com');
    } finally { env.CORS_ORIGINS = []; }
  });
});

describe('sign-in under attack', () => {
  test('parallel wrong passwords cannot get more guesses than the lockout allows', async () => {
    const u = await signUp();
    const results = await Promise.all(Array.from({ length: 10 }, () => api().post('/api/v1/auth/login').send({ email: u.email, password: 'Wrong-pass1' })));
    const checked = results.filter((r) => r.status === 401).length;
    assert.ok(checked >= 1 && checked <= env.LOGIN_MAX_FAILURES, `${checked} passwords were checked`);
    assert.ok(results.every((r) => r.status === 401 || r.status === 429));
    // The account is now locked, even for the right password.
    await api().post('/api/v1/auth/login').send({ email: u.email, password: u.password }).expect(429);
    const user = await User.findById(u.userId).lean();
    assert.ok(user!.lockedUntil! > new Date());
  });

  test('a right password after a few wrong ones clears the count', async () => {
    const u = await signUp();
    for (let i = 0; i < env.LOGIN_MAX_FAILURES - 1; i++) await api().post('/api/v1/auth/login').send({ email: u.email, password: 'Wrong-pass1' }).expect(401);
    await api().post('/api/v1/auth/login').send({ email: u.email, password: u.password }).expect(200);
    assert.equal((await User.findById(u.userId).lean())!.failedLoginCount, 0);
  });
});

describe('the first Owner from OWNER_EMAIL', () => {
  test('is created at start-up with a set-password link, and nobody can claim the installation by signing up', async () => {
    const email = uniqueEmail('owner');
    env.OWNER_EMAIL = email;
    clearMail();
    try {
      const created = await ensureFirstOwner();
      assert.equal(created.created, true);
      // Every other instance starting at the same time finds the slot taken.
      assert.deepEqual(await Promise.all([ensureFirstOwner(), ensureFirstOwner()]), [{ created: false }, { created: false }]);

      const owner = await User.findOne({ email }).lean();
      const ownerRole = await Role.findOne({ key: 'owner' }).lean();
      assert.deepEqual(owner!.roleIds.map(String), [String(ownerRole!._id)]);
      assert.equal(await User.countDocuments(), 1);

      const stranger = await api().post('/api/v1/auth/register').send({ name: 'Stranger', email: uniqueEmail(), password: 'Passw0rd!' }).expect(403);
      assert.equal(errorCode(stranger), 'FORBIDDEN');
      await api().post('/api/v1/auth/register').send({ name: 'Stranger', email, password: 'Passw0rd!' }).expect(409);

      const mail = recentMail().find((m) => m.to === email);
      assert.ok(mail, 'the invitation was sent');
      const token = /#reset=([\w-]+)/.exec(mail!.text)![1]!;
      await api().post('/api/v1/auth/reset-password').send({ token, password: 'Owner-pass1' }).expect(200);
      const login = await api().post('/api/v1/auth/login').send({ email, password: 'Owner-pass1' }).expect(200);
      assert.deepEqual(login.body.data.roles.map((r: { key: string }) => r.key), ['owner']);
    } finally { env.OWNER_EMAIL = undefined; }
  });

  test('without OWNER_EMAIL nothing is created', async () => {
    assert.deepEqual(await ensureFirstOwner(), { created: false });
    assert.equal(await User.countDocuments(), 0);
  });
});

describe('uploads', () => {
  test('one person can upload only so many files in ten minutes', async () => {
    const owner = await signUp('Owner');
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('photo')]);
    const send = () => api().post('/api/v1/files').set(bearer(owner)).set('Content-Type', 'image/png').send(png);
    const results = [];
    for (let i = 0; i < 61; i++) results.push((await send()).status);
    assert.equal(results.filter((s) => s === 201).length, 60);
    assert.equal(results.at(-1), 429);
  });
});

describe('rate-limit memory', () => {
  test('the in-memory store keeps at most maxKeys windows', async () => {
    const store = new MemoryRateLimitStore(3);
    for (const key of ['a', 'b', 'c', 'd', 'e']) await store.hit(key, 5, 60000);
    assert.equal(store.size, 3);
    // A key already held keeps counting.
    await store.hit('e', 5, 60000);
    assert.equal((await store.hit('e', 5, 60000)).count, 3);
  });
});

describe('logs', () => {
  test('secrets are redacted wherever they sit in a logged object', () => {
    const lines: string[] = [];
    const sink = new Writable({ write(chunk, _enc, done) { lines.push(String(chunk)); done(); } });
    const log = pino({ redact: REDACT_PATHS }, sink);
    log.info({
      password: 'p1', body: { newPassword: 'p2', refreshToken: 'r1' }, err: { config: { authorization: 'Bearer x', apiKey: 'k1' } },
      req: { headers: { authorization: 'Bearer y', 'x-webhook-secret': 's1' } }, user: { passwordHash: 'h1' }, email: 'kept@example.com',
    }, 'x');
    const out = lines.join('');
    for (const secret of ['p1', 'p2', 'r1', 'Bearer x', 'k1', 'Bearer y', 's1', 'h1']) assert.ok(!out.includes(`"${secret}"`), `${secret} leaked: ${out}`);
    assert.ok(out.includes('kept@example.com'));
  });
});

describe('indexes for the desks', () => {
  test('the queues the desks read are indexed', async () => {
    const has = async (model: { collection: { indexes(): Promise<Array<{ key: Record<string, unknown> }>> } }, key: Record<string, number>) =>
      (await model.collection.indexes()).some((i) => JSON.stringify(i.key) === JSON.stringify(key));
    assert.ok(await has(FundRequest, { status: 1, createdAt: 1 }));
    assert.ok(await has(Expense, { status: 1, at: 1 }));
    assert.ok(await has(DriverDocument, { status: 1, kind: 1, at: 1 }));
    assert.ok(await has(Consignment, { 'shortage.status': 1 }));
    assert.ok(await has(Trip, { createdAt: -1 }));
  });
});
