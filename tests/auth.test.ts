import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { env } from '../src/config/env.js';
import { signAccessToken, verifyAccessToken } from '../src/core/security/jwt.js';
import { hashPassword, verifyPassword } from '../src/core/security/password.js';
import { Company } from '../src/modules/company/company.model.js';
import { User } from '../src/modules/users/user.model.js';
import { PasswordReset } from '../src/modules/auth/passwordReset.model.js';
import { api, bearer, errorCode, resetDatabase, signUp, startDatabase, stopDatabase, uniqueEmail, userWithRole } from './helpers.js';

before(startDatabase);
after(stopDatabase);
beforeEach(resetDatabase);

describe('password hashing and tokens', () => {
  test('scrypt hashes verify, differ per salt, and reject wrong passwords', async () => {
    const a = await hashPassword('Correct1horse');
    const b = await hashPassword('Correct1horse');
    assert.notEqual(a, b);
    assert.ok(await verifyPassword('Correct1horse', a));
    assert.equal(await verifyPassword('correct1horse', a), false);
    assert.equal(await verifyPassword('x', 'not-a-hash'), false);
    assert.equal(await verifyPassword('x', 'scrypt$10$8$1$$'), false);
  });

  test('access tokens reject tampering, other secrets, wrong algorithm and expiry', () => {
    const { token } = signAccessToken({ sub: 'a'.repeat(24), sid: 'b'.repeat(24), tv: 0 });
    assert.deepEqual(verifyAccessToken(token), { sub: 'a'.repeat(24), sid: 'b'.repeat(24), tv: 0 });
    const [h, p, s] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, 'base64url').toString()), sub: 'c'.repeat(24) })).toString('base64url');
    assert.equal(verifyAccessToken(`${h}.${forged}.${s}`), null);
    assert.equal(verifyAccessToken(token, 'another-secret-another-secret-123456'), null);
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${p}.`;
    assert.equal(verifyAccessToken(none), null);
    assert.equal(verifyAccessToken('a.b'), null);
    assert.equal(verifyAccessToken('a.b.c'), null);
    const expired = signAccessToken({ sub: 'a'.repeat(24), sid: 'b'.repeat(24), tv: 0 }, -10);
    assert.equal(verifyAccessToken(expired.token), null);
  });
});

describe('registration', () => {
  test('first account becomes owner; later sign-ups are refused until the company allows them, then become viewers', async () => {
    const first = await api().post('/api/v1/auth/register').send({ name: 'Owner', email: uniqueEmail(), password: 'Passw0rd!' }).expect(201);
    assert.equal(first.body.data.firstOwner, true);
    assert.deepEqual(first.body.data.roles.map((r: { key: string }) => r.key), ['owner']);
    assert.equal(first.body.data.user.passwordHash, undefined);
    assert.equal(first.body.data.user.tokenVersion, undefined);
    const refused = await api().post('/api/v1/auth/register').send({ name: 'Stranger', email: uniqueEmail(), password: 'Passw0rd!' }).expect(403);
    assert.equal(errorCode(refused), 'FORBIDDEN');
    await api().put('/api/v1/company').set({ Authorization: `Bearer ${first.body.data.accessToken}` }).send({ legalName: 'Marichi', allowSelfRegistration: true }).expect(200);
    const second = await api().post('/api/v1/auth/register').send({ name: 'Second', email: uniqueEmail(), password: 'Passw0rd!' }).expect(201);
    assert.equal(second.body.data.firstOwner, false);
    assert.deepEqual(second.body.data.roles.map((r: { key: string }) => r.key), ['viewer']);
  });

  test('simultaneous first sign-ups produce exactly one owner', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => api().post('/api/v1/auth/register').send({ name: `P${i}`, email: uniqueEmail('race'), password: 'Passw0rd!' })));
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.equal(results.filter((r) => r.status === 201 && r.body.data.firstOwner).length, 1);
    assert.ok(results.every((r) => r.status === 201 || r.status === 403));
  });

  test('rejects duplicate e-mails case-insensitively and weak or malformed input', async () => {
    const email = uniqueEmail();
    await api().post('/api/v1/auth/register').send({ name: 'A', email, password: 'Passw0rd!' }).expect(201);
    const dup = await api().post('/api/v1/auth/register').send({ name: 'B', email: email.toUpperCase(), password: 'Passw0rd!' }).expect(409);
    assert.equal(errorCode(dup), 'CONFLICT');
    for (const password of ['short1', 'lettersonly', '12345678', 'a1'.repeat(65)]) {
      const r = await api().post('/api/v1/auth/register').send({ name: 'C', email: uniqueEmail(), password }).expect(422);
      assert.ok(r.body.error.details.body.fieldErrors.password);
    }
    await api().post('/api/v1/auth/register').send({ name: 'D', email: 'not-an-email', password: 'Passw0rd!' }).expect(422);
    await api().post('/api/v1/auth/register').send({ name: '', email: uniqueEmail(), password: 'Passw0rd!' }).expect(422);
    await api().post('/api/v1/auth/register').send({ name: 'E', email: uniqueEmail(), password: 'Passw0rd!', role: 'owner' }).expect(422);
    await api().post('/api/v1/auth/register').send({ name: 'F', email: uniqueEmail(), password: 'Passw0rd!', roleIds: ['x'] }).expect(422);
  });

  test('self sign-up can be switched off again by the company', async () => {
    const owner = await signUp('Owner');
    await api().put('/api/v1/company').set(bearer(owner)).send({ legalName: 'Marichi', allowSelfRegistration: true }).expect(200);
    await api().post('/api/v1/auth/register').send({ name: 'Early', email: uniqueEmail(), password: 'Passw0rd!' }).expect(201);
    const company = await api().get('/api/v1/company').set(bearer(owner)).expect(200);
    await api().put('/api/v1/company').set(bearer(owner)).send({ legalName: 'Marichi', allowSelfRegistration: false, version: company.body.data.version }).expect(200);
    const blocked = await api().post('/api/v1/auth/register').send({ name: 'Late', email: uniqueEmail(), password: 'Passw0rd!' }).expect(403);
    assert.equal(errorCode(blocked), 'FORBIDDEN');
    assert.equal(await Company.countDocuments(), 1);
  });
});

describe('sign-in and sessions', () => {
  test('wrong password and unknown e-mail give the same answer', async () => {
    const u = await signUp();
    const wrong = await api().post('/api/v1/auth/login').send({ email: u.email, password: 'Wrong1234' }).expect(401);
    const unknown = await api().post('/api/v1/auth/login').send({ email: uniqueEmail('nobody'), password: 'Wrong1234' }).expect(401);
    assert.equal(wrong.body.error.message, unknown.body.error.message);
  });

  test('locks the account after repeated failures and unlocks on reset', async () => {
    const u = await signUp();
    for (let i = 0; i < env.LOGIN_MAX_FAILURES; i += 1) await api().post('/api/v1/auth/login').send({ email: u.email, password: 'Wrong1234' }).expect(401);
    const locked = await api().post('/api/v1/auth/login').send({ email: u.email, password: u.password }).expect(429);
    assert.ok(locked.body.error.details.lockedUntil);
    const forgot = await api().post('/api/v1/auth/forgot-password').send({ email: u.email }).expect(200);
    await api().post('/api/v1/auth/reset-password').send({ token: forgot.body.data.resetToken, password: 'NewPass123' }).expect(200);
    await api().post('/api/v1/auth/login').send({ email: u.email, password: 'NewPass123' }).expect(200);
  });

  test('login is rate limited per account and per address', async () => {
    const u = await signUp();
    let last = 0;
    for (let i = 0; i < 12; i += 1) last = (await api().post('/api/v1/auth/login').send({ email: `x${u.email}`, password: 'Wrong1234' })).status;
    assert.equal(last, 429);
    const r = await api().post('/api/v1/auth/login').send({ email: `x${u.email}`, password: 'Wrong1234' });
    assert.ok(Number(r.headers['retry-after']) > 0);
  });

  test('protected routes need a valid bearer token', async () => {
    await api().get('/api/v1/auth/me').expect(401);
    await api().get('/api/v1/auth/me').set('Authorization', 'Bearer nonsense').expect(401);
    await api().get('/api/v1/auth/me').set('Authorization', 'Basic abc').expect(401);
    await api().get('/api/v1/vehicles').expect(401);
    const forged = signAccessToken({ sub: 'a'.repeat(24), sid: 'b'.repeat(24), tv: 0 });
    await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${forged.token}`).expect(401);
  });

  test('refresh rotates tokens; replaying an old refresh token signs out that device chain', async () => {
    const u = await signUp();
    const r1 = await api().post('/api/v1/auth/refresh').send({ refreshToken: u.refreshToken }).expect(200);
    assert.notEqual(r1.body.data.refreshToken, u.refreshToken);
    await api().get('/api/v1/auth/me').set(bearer({ token: r1.body.data.accessToken })).expect(200);
    await api().get('/api/v1/auth/me').set(bearer(u)).expect(401);
    await api().post('/api/v1/auth/refresh').send({ refreshToken: u.refreshToken }).expect(401);
    await api().post('/api/v1/auth/refresh').send({ refreshToken: r1.body.data.refreshToken }).expect(401);
    await api().get('/api/v1/auth/me').set(bearer({ token: r1.body.data.accessToken })).expect(401);
  });

  test('concurrent refreshes with one token succeed at most once', async () => {
    const u = await signUp();
    const results = await Promise.all(Array.from({ length: 6 }, () => api().post('/api/v1/auth/refresh').send({ refreshToken: u.refreshToken })));
    assert.equal(results.filter((r) => r.status === 200).length, 1);
  });

  test('logout ends this session, logout-all ends every session', async () => {
    const u = await signUp();
    const second = await api().post('/api/v1/auth/login').send({ email: u.email, password: u.password }).expect(200);
    await api().post('/api/v1/auth/logout').set(bearer(u)).expect(204);
    await api().get('/api/v1/auth/me').set(bearer(u)).expect(401);
    await api().get('/api/v1/auth/me').set(bearer({ token: second.body.data.accessToken })).expect(200);
    const sessions = await api().get('/api/v1/auth/sessions').set(bearer({ token: second.body.data.accessToken })).expect(200);
    assert.equal(sessions.body.data.length, 1);
    assert.equal(sessions.body.data[0].current, true);
    await api().post('/api/v1/auth/logout-all').set(bearer({ token: second.body.data.accessToken })).expect(204);
    await api().get('/api/v1/auth/me').set(bearer({ token: second.body.data.accessToken })).expect(401);
    await api().post('/api/v1/auth/refresh').send({ refreshToken: second.body.data.refreshToken }).expect(401);
  });

  test('profile updates and password change', async () => {
    const u = await signUp('Before');
    const other = await api().post('/api/v1/auth/login').send({ email: u.email, password: u.password }).expect(200);
    const me = await api().patch('/api/v1/auth/me').set(bearer(u)).send({ name: 'After', phone: '+260 97 1234567' }).expect(200);
    assert.equal(me.body.data.user.name, 'After');
    assert.equal(me.body.data.user.phone, '+260971234567');
    await api().patch('/api/v1/auth/me').set(bearer(u)).send({ phone: null }).expect(200);
    await api().patch('/api/v1/auth/me').set(bearer(u)).send({}).expect(422);
    await api().patch('/api/v1/auth/me').set(bearer(u)).send({ email: 'x@y.z' }).expect(422);
    await api().post('/api/v1/auth/change-password').set(bearer(u)).send({ currentPassword: 'Wrong1234', newPassword: 'Another123' }).expect(422);
    await api().post('/api/v1/auth/change-password').set(bearer(u)).send({ currentPassword: u.password, newPassword: u.password }).expect(422);
    const changed = await api().post('/api/v1/auth/change-password').set(bearer(u)).send({ currentPassword: u.password, newPassword: 'Another123' }).expect(200);
    await api().get('/api/v1/auth/me').set(bearer({ token: other.body.data.accessToken })).expect(401);
    await api().get('/api/v1/auth/me').set(bearer({ token: changed.body.data.accessToken })).expect(200);
    await api().post('/api/v1/auth/login').send({ email: u.email, password: 'Another123' }).expect(200);
  });

  test('a deactivated user cannot sign in or keep using a token', async () => {
    const owner = await signUp('Owner');
    const viewer = await userWithRole(owner, 'viewer');
    const user = await api().get(`/api/v1/users/${viewer.userId}`).set(bearer(owner)).expect(200);
    await api().patch(`/api/v1/users/${viewer.userId}`).set(bearer(owner)).send({ version: user.body.data.version, status: 'inactive' }).expect(200);
    await api().get('/api/v1/auth/me').set(bearer(viewer)).expect(401);
    await api().post('/api/v1/auth/login').send({ email: viewer.email, password: viewer.password }).expect(403);
  });
});

describe('password reset', () => {
  test('does not reveal whether an e-mail exists', async () => {
    const r = await api().post('/api/v1/auth/forgot-password').send({ email: uniqueEmail('ghost') }).expect(200);
    assert.deepEqual(r.body.data, {});
  });

  test('tokens are single-use, invalidate older tokens, and end every session', async () => {
    const u = await signUp();
    const first = await api().post('/api/v1/auth/forgot-password').send({ email: u.email }).expect(200);
    const second = await api().post('/api/v1/auth/forgot-password').send({ email: u.email }).expect(200);
    await api().post('/api/v1/auth/reset-password').send({ token: first.body.data.resetToken, password: 'Reset1234' }).expect(422);
    await api().post('/api/v1/auth/reset-password').send({ token: second.body.data.resetToken, password: 'weak' }).expect(422);
    await api().post('/api/v1/auth/reset-password').send({ token: second.body.data.resetToken, password: 'Reset1234' }).expect(200);
    await api().post('/api/v1/auth/reset-password').send({ token: second.body.data.resetToken, password: 'Reset5678' }).expect(422);
    await api().get('/api/v1/auth/me').set(bearer(u)).expect(401);
    await api().post('/api/v1/auth/login').send({ email: u.email, password: 'Reset1234' }).expect(200);
    const stored = await PasswordReset.find({}).lean();
    assert.ok(stored.every((s) => s.tokenHash.length === 64 && s.tokenHash !== second.body.data.resetToken));
  });

  test('expired tokens are refused', async () => {
    const u = await signUp();
    const r = await api().post('/api/v1/auth/forgot-password').send({ email: u.email }).expect(200);
    await PasswordReset.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    await api().post('/api/v1/auth/reset-password').send({ token: r.body.data.resetToken, password: 'Reset1234' }).expect(422);
  });

  test('admin-created users without a password get an invitation that sets one', async () => {
    const owner = await signUp('Owner');
    const roles = await api().get('/api/v1/roles').set(bearer(owner)).query({ search: 'viewer' });
    const email = uniqueEmail('invite');
    const created = await api().post('/api/v1/users').set(bearer(owner)).send({ name: 'Invited', email, roleIds: [roles.body.data[0].id] }).expect(201);
    assert.ok(created.body.data.invitation.resetToken);
    await api().post('/api/v1/auth/reset-password').send({ token: created.body.data.invitation.resetToken, password: 'Invited123' }).expect(200);
    await api().post('/api/v1/auth/login').send({ email, password: 'Invited123' }).expect(200);
    const stored = await User.findOne({ email }).select('+passwordHash').lean();
    assert.ok(stored?.passwordHash.startsWith('scrypt$'));
  });
});
