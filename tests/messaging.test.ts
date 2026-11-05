// #19: message connections (on connections since #59), the dispatcher, the outbox, retries, resend, simulator mode and secrets.
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { env } from '../src/config/env.js';
import { setSmtpTransportFactory, type SmtpSettings } from '../src/core/mail/mailer.js';
import { z } from 'zod';
import { registerProvider } from '../src/core/connections/index.js';
import { simulatedMessages } from '../src/core/connections/providers/messages.js';
import { dispatch, processDue, RETRY_MINUTES } from '../src/modules/messaging/dispatcher.js';
import { OutboundMessage } from '../src/modules/messaging/models/connection.model.js';
import { NotificationRule } from '../src/modules/messaging/models/messaging.model.js';
import { api, bearer, find, loadSample, resetDatabase, signUp, startDatabase, stopDatabase, userWithRole, type Session } from './helpers.js';

const SECRET = 'smtp-pass-7Hq2-do-not-leak';
process.env.MESSAGING_SMTP_PASS = SECRET;

/** A stand-in SMTP server: records what it is given; fails while `failures` > 0, quoting the password like some servers do. */
const smtp = { sent: [] as Array<{ to: string; subject: string; text: string; attachments?: unknown[] }>, failures: 0, settings: [] as SmtpSettings[] };
function fakeSmtp() {
  setSmtpTransportFactory((settings) => {
    smtp.settings.push(settings);
    return {
      sendMail: (async (m: { to: string; subject: string; text: string }) => {
        if (smtp.failures > 0) { smtp.failures -= 1; throw new Error(`535 Authentication failed for ${settings.user}:${settings.pass}`); }
        smtp.sent.push(m);
        return { messageId: `<${smtp.sent.length}@fake>` };
      }) as never,
    };
  });
}

/** A real (not simulated) SMS provider for tests. */
const smsSent: Array<{ to: string; text: string; secret?: string }> = [];
registerProvider({
  kind: 'sms', key: 'test-sms', label: 'Test provider', fields: z.strictObject({ account: z.string().optional(), senderId: z.string().optional() }),
  secrets: [{ key: 'apiKey', label: 'API key', required: true }],
  test: async () => ({ ok: true, message: 'ready' }),
  open: (ctx) => ({ async send(m) { smsSent.push({ to: m.to, text: m.text, secret: ctx.secret('apiKey') }); return { providerRef: `t-${smsSent.length}` }; } }),
});

let owner: Session;
const as = (s: Session) => ({
  get: (path: string, query: Record<string, unknown> = {}) => api().get(`/api/v1${path}`).query(query).set(bearer(s)),
  post: (path: string, body?: unknown) => api().post(`/api/v1${path}`).set(bearer(s)).send(body as object),
  patch: (path: string, body: unknown) => api().patch(`/api/v1${path}`).set(bearer(s)).send(body as object),
});

async function emailConnection(extra: Record<string, unknown> = {}) {
  const { settings, ...rest } = extra as { settings?: Record<string, unknown> };
  const res = await as(owner).post('/connections', {
    code: `EM${Math.random().toString(36).slice(2, 7)}`, name: 'Company SMTP', kind: 'email', provider: 'smtp', enabled: true,
    settings: { host: 'smtp.example.com', port: 587, user: 'fleet@example.com', from: 'Marichi Fleet <fleet@example.com>', ...settings },
    secrets: { password: 'MESSAGING_SMTP_PASS' }, ...rest,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

/** An e-mail and an SMS template for trip.dispatched, and a rule sending both to the driver and Finance. */
async function dispatchRule(extra: Record<string, unknown> = {}) {
  const email = await as(owner).post('/message-templates', { code: 'EM-DISP', name: 'Dispatched (e-mail)', channel: 'email', event: 'trip.dispatched', subject: 'Trip {{trip.number}} has left', body: 'Hello {{driver.name}}, trip {{trip.number}} for {{company.name}} has left.' });
  const sms = await as(owner).post('/message-templates', { code: 'SMS-DISP', name: 'Dispatched (SMS)', channel: 'sms', event: 'trip.dispatched', body: 'Trip {{trip.number}} has left. {{link}}' });
  assert.equal(email.status, 201, JSON.stringify(email.body));
  assert.equal(sms.status, 201, JSON.stringify(sms.body));
  const finance = await find(owner, 'roles', 'finance');
  const rule = await as(owner).post('/notification-rules', {
    code: 'NR-DISP', name: 'Trip dispatched', event: 'trip.dispatched',
    recipients: [{ kind: 'driver' }, { kind: 'role', roleId: finance.id }],
    templates: [{ channel: 'email', templateId: email.body.data.id }, { channel: 'sms', templateId: sms.body.data.id }], ...extra,
  });
  assert.equal(rule.status, 201, JSON.stringify(rule.body));
  return rule.body.data;
}

before(startDatabase);
after(stopDatabase);
beforeEach(async () => {
  await resetDatabase();
  owner = await signUp('Owner');
  smtp.sent.length = 0; smtp.failures = 0; smtp.settings.length = 0; smsSent.length = 0;
  fakeSmtp();
});
afterEach(() => { setSmtpTransportFactory(null); env.DRIVER_PHONE_SIMULATOR = true; });

describe('connections', () => {
  test('are checked against their provider, and may only name allowed secrets', async () => {
    const settings = { host: 'smtp.example.com', from: 'Fleet <f@example.com>' };
    const base = { code: 'C1', name: 'SMTP', kind: 'email', provider: 'smtp', settings };
    for (const name of ['JWT_SECRET', 'MONGODB_URI', 'messaging_x', 'MESSAGING_', 'CONNECTION_']) {
      const r = await as(owner).post('/connections', { ...base, settings: { ...settings, user: 'u' }, secrets: { password: name } });
      assert.equal(r.status, 422, `${name} was accepted`);
    }
    assert.equal((await as(owner).post('/connections', { ...base, settings: { ...settings, senderId: 'FLEET' } })).status, 422, 'an SMS field on e-mail');
    assert.equal((await as(owner).post('/connections', { ...base, secrets: { apiKey: 'MESSAGING_X' } })).status, 422, 'a secret the provider does not use');
    assert.equal((await as(owner).post('/connections', { ...base, provider: 'twilio' })).status, 422, 'an SMS provider on e-mail');
    assert.equal((await as(owner).post('/connections', { ...base, settings: { host: 'smtp.example.com' } })).status, 422, 'no From address');
    assert.equal((await as(owner).post('/connections', { code: 'S1', name: 'SMS', kind: 'sms', provider: 'nonesuch' })).status, 422);
    assert.equal((await as(owner).post('/connections', { code: 'S1', name: 'SMS', kind: 'sms', provider: 'twilio', settings: { accountSid: `AC${'0'.repeat(32)}`, from: '+15551234567' } })).status, 422, 'Twilio without its auth token');
    assert.equal((await as(owner).post('/connections', { code: 'S1', name: 'SMS', kind: 'sms', provider: 'simulated', settings: { senderId: 'FLEET' } })).status, 201);
  });

  test('edit, archive, restore and delete like every master', async () => {
    const c = await emailConnection();
    const edited = await as(owner).patch(`/connections/${c.id}`, { version: c.version, settings: { ...c.settings, port: 465, secure: true } }).expect(200);
    assert.equal(edited.body.data.settings.port, 465);
    await as(owner).patch(`/connections/${c.id}`, { version: c.version, settings: { ...c.settings, port: 25 } }).expect(409);
    await as(owner).post(`/connections/${c.id}/archive`, { reason: 'Moved to another provider' }).expect(200);
    assert.equal((await as(owner).get('/message-channels')).body.data[0].via, 'simulated', 'an archived connection is not used');
    await as(owner).post(`/connections/${c.id}/restore`).expect(200);
    const history = await as(owner).get(`/connections/${c.id}/history`).expect(200);
    assert.ok(history.body.data.length >= 3);
    await api().delete(`/api/v1/connections/${c.id}`).set(bearer(owner)).expect(204);
  });

  test('only one is switched on per kind', async () => {
    await emailConnection();
    const settings = { host: 'mail.example.com', from: 'x@example.com' };
    const second = await as(owner).post('/connections', { code: 'C2', name: 'Other', kind: 'email', provider: 'smtp', enabled: true, settings });
    assert.equal(second.status, 409);
    await as(owner).post('/connections', { code: 'C3', name: 'Spare', kind: 'email', provider: 'smtp', enabled: false, settings }).expect(201);
  });

  test('secrets never come back from the API', async () => {
    const created = await emailConnection();
    assert.deepEqual(created.secrets, { password: 'MESSAGING_SMTP_PASS' });
    assert.deepEqual(created.secretsSet, { password: true });
    smtp.failures = 1;
    await as(owner).post(`/connections/${created.id}/test`, { to: 'ops@example.com' }).expect(200);
    for (const path of ['/connections', `/connections/${created.id}`, '/message-outbox', '/message-channels', '/connection-kinds', `/connections/${created.id}/history`]) {
      const r = await as(owner).get(path).expect(200);
      assert.ok(!JSON.stringify(r.body).includes(SECRET), `${path} returned the password`);
    }
    const after = await as(owner).get(`/connections/${created.id}`).expect(200);
    assert.match(after.body.data.lastTest.message, /\[hidden\]/);
  });

  test('send a test message: sent, kept on the connection and in the outbox', async () => {
    const c = await emailConnection({ enabled: false });
    const ok = await as(owner).post(`/connections/${c.id}/test`, { to: 'ops@example.com' }).expect(200);
    assert.equal(ok.body.data.ok, true);
    assert.equal(ok.body.data.status, 'sent');
    assert.equal(smtp.sent[0]!.to, 'ops@example.com');
    assert.equal(smtp.settings[0]!.pass, SECRET, 'the password comes from the environment');
    const stored = (await as(owner).get(`/connections/${c.id}`)).body.data;
    assert.equal(stored.lastTest.ok, true);
    assert.equal(stored.lastTest.to, 'ops@example.com');

    smtp.failures = 1;
    const bad = await as(owner).post(`/connections/${c.id}/test`, { to: 'ops@example.com' }).expect(200);
    assert.equal(bad.body.data.ok, false);
    assert.equal(bad.body.data.message.status, 'failed', 'a test is one attempt, not retried');
    await as(owner).post(`/connections/${c.id}/test`, { to: '+260971234567' }).expect(422);
    await as(owner).post(`/connections/${c.id}/test`, {}).expect(422);
  });

  test('channel status says where each channel sends', async () => {
    let status = (await as(owner).get('/message-channels').expect(200)).body.data;
    assert.deepEqual(status.map((c: { via: string }) => c.via), ['simulated', 'simulated', 'simulated']);
    assert.ok(status[0].providers.some((p: { key: string }) => p.key === 'smtp'));
    assert.ok(status[1].providers.some((p: { key: string; simulated: boolean }) => p.key === 'simulated' && p.simulated));
    // Reasons are for the office: they never name a server setting.
    for (const c of status) assert.doesNotMatch(c.simulated, /[A-Z]{2,}_[A-Z_]+|#\d+/, `${c.channel}: ${c.simulated}`);
    assert.match(status[1].simulated, /test setup: phone messages are simulated, not sent/);
    await emailConnection();
    status = (await as(owner).get('/message-channels')).body.data;
    assert.equal(status[0].via, 'connection');
    assert.equal(status[0].connectionName, 'Company SMTP');
  });
});

describe('dispatching', () => {
  test('fans out to every channel and recipient of the rule, rendering each template', async () => {
    await loadSample(owner);
    await NotificationRule.deleteMany({ isDefault: true }); // only this test's rules (the defaults have their own tests)
    const driver = await find(owner, 'drivers', 'Joseph');
    const financeUser = await userWithRole(owner, 'finance', 'Natasha Banda');
    await emailConnection();
    await dispatchRule();
    const out = await dispatch({ event: 'trip.dispatched', driverId: driver.id, variables: { 'trip.number': 'TRIP/26/0001', link: 'https://fleet.example.com/t/1' }, ref: { kind: 'trips', id: 'x' } });
    const by = (channel: string, name: string) => out.find((m) => m.channel === channel && m.toName === name)!;

    const toFinance = by('email', 'Natasha Banda');
    assert.equal(toFinance.status, 'sent');
    assert.equal(toFinance.to, financeUser.email);
    assert.equal(toFinance.subject, 'Trip TRIP/26/0001 has left');
    assert.match(toFinance.body, /Hello Joseph Mwansa, trip TRIP\/26\/0001 for Marichi Fleet has left\./);
    assert.equal(smtp.sent.find((m) => m.to === financeUser.email)!.subject, 'Trip TRIP/26/0001 has left');

    assert.equal(by('email', 'Joseph Mwansa').status, 'skipped', 'the driver has no e-mail');
    assert.match(by('email', 'Joseph Mwansa').note!, /no e-mail address/);
    // Simulators are on in tests: phones get nothing, and the outbox says so.
    const sms = by('sms', 'Joseph Mwansa');
    assert.equal(sms.status, 'simulated');
    assert.match(sms.note!, /test setup: phone messages are simulated/);
    assert.equal(sms.body, 'Trip TRIP/26/0001 has left. https://fleet.example.com/t/1');
    assert.equal(by('sms', 'Natasha Banda').status, 'skipped');
    assert.equal(out.length, 4);
  });

  test('with simulators off, SMS goes to the configured provider with its key from the environment', async () => {
    env.DRIVER_PHONE_SIMULATOR = false;
    process.env.MESSAGING_SMS_KEY = 'sms-key-123';
    await loadSample(owner);
    await NotificationRule.deleteMany({ isDefault: true }); // only this test's rules (the defaults have their own tests)
    const driver = await find(owner, 'drivers', 'Joseph');
    await as(owner).post('/connections', { code: 'SMS', name: 'SMS', kind: 'sms', provider: 'test-sms', enabled: true, settings: { account: 'marichi', senderId: 'MARICHI' }, secrets: { apiKey: 'MESSAGING_SMS_KEY' } }).expect(201);
    await dispatchRule();
    const out = await dispatch({ event: 'trip.dispatched', driverId: driver.id, variables: { 'trip.number': 'T2' } });
    const sms = out.find((m) => m.channel === 'sms' && m.toName === 'Joseph Mwansa')!;
    assert.equal(sms.status, 'sent');
    assert.equal(sms.providerRef, 't-1');
    assert.deepEqual(smsSent[0], { to: '+260971234567', text: 'Trip T2 has left. ', secret: 'sms-key-123' });
  });

  test('a simulated SMS provider records the message as Simulated', async () => {
    env.DRIVER_PHONE_SIMULATOR = false;
    await loadSample(owner);
    await NotificationRule.deleteMany({ isDefault: true }); // only this test's rules (the defaults have their own tests)
    const driver = await find(owner, 'drivers', 'Joseph');
    await as(owner).post('/connections', { code: 'SMS', name: 'SMS', kind: 'sms', provider: 'simulated', enabled: true }).expect(201);
    await dispatchRule();
    const before = simulatedMessages().length;
    const out = await dispatch({ event: 'trip.dispatched', driverId: driver.id, variables: { 'trip.number': 'T3' } });
    assert.equal(out.find((m) => m.channel === 'sms' && m.toName === 'Joseph Mwansa')!.status, 'simulated');
    assert.equal(simulatedMessages().length, before + 1);
  });

  test('a failed send retries with back-off, then is marked failed', async () => {
    const financeUser = await userWithRole(owner, 'finance', 'Natasha Banda');
    await emailConnection();
    await dispatchRule();
    smtp.failures = 1;
    const [first] = (await dispatch({ event: 'trip.dispatched', variables: { 'trip.number': 'T4' } })).filter((m) => m.channel === 'email');
    assert.equal(first!.status, 'queued');
    assert.equal(first!.attempts, 1);
    assert.match(first!.note!, /\[hidden\]/);
    assert.ok(!first!.note!.includes(SECRET));
    const wait = new Date(first!.nextAttemptAt!).getTime() - Date.now();
    assert.ok(wait > (RETRY_MINUTES[0]! * 60000) - 5000 && wait <= RETRY_MINUTES[0]! * 60000, `waits ${wait} ms`);
    assert.equal(await processDue(), 0, 'nothing is due yet');
    await OutboundMessage.updateOne({ _id: first!.id }, { $set: { nextAttemptAt: new Date(Date.now() - 1000) } });
    assert.equal(await processDue(), 1);
    const sent = await OutboundMessage.findById(first!.id).lean();
    assert.equal(sent!.status, 'sent');
    assert.equal(sent!.attempts, 2);
    assert.equal(smtp.sent.filter((m) => m.to === financeUser.email).length, 1);

    smtp.failures = 99;
    const [second] = (await dispatch({ event: 'trip.dispatched', variables: { 'trip.number': 'T5' } })).filter((m) => m.channel === 'email');
    for (let i = 1; i < RETRY_MINUTES.length; i++) {
      await OutboundMessage.updateOne({ _id: second!.id }, { $set: { nextAttemptAt: new Date(Date.now() - 1000) } });
      await processDue();
    }
    const failed = await OutboundMessage.findById(second!.id).lean();
    assert.equal(failed!.status, 'failed');
    assert.equal(failed!.attempts, RETRY_MINUTES.length);
    const connection = (await as(owner).get('/connections')).body.data[0];
    assert.match(connection.lastError.message, /535/);
  });

  test('a half-sent message left by a crashed worker is picked up again', async () => {
    await userWithRole(owner, 'finance', 'Natasha Banda');
    await emailConnection();
    await dispatchRule({ delayMinutes: 30 });
    const [delayed] = (await dispatch({ event: 'trip.dispatched', variables: { 'trip.number': 'T6' } })).filter((m) => m.channel === 'email');
    assert.equal(delayed!.status, 'queued', 'a delayed rule waits');
    assert.equal(smtp.sent.length, 0);
    await OutboundMessage.updateOne({ _id: delayed!.id }, { $set: { status: 'sending', leaseUntil: new Date(Date.now() - 1000) } });
    await processDue();
    assert.equal((await OutboundMessage.findById(delayed!.id).lean())!.status, 'sent');
  });

  test('no rule, no messages; an unknown event is refused', async () => {
    assert.deepEqual(await dispatch({ event: 'trip.closed' }), []);
    await assert.rejects(dispatch({ event: 'nope' as never }), /Unknown event/);
  });
});

describe('the outbox', () => {
  test('lists, filters and resends; only people who manage connections may resend', async () => {
    await userWithRole(owner, 'finance', 'Natasha Banda');
    await emailConnection();
    await dispatchRule();
    await dispatch({ event: 'trip.dispatched', variables: { 'trip.number': 'T7' } });
    const list = await as(owner).get('/message-outbox', { channel: 'email', status: 'sent' }).expect(200);
    assert.equal(list.body.meta.total, 1);
    const original = list.body.data[0];
    assert.equal(original.resendable, true);
    await as(owner).get('/message-outbox', { status: 'nonsense' }).expect(422);
    await as(owner).get('/message-outbox', { search: '.*' }).expect(200);

    const viewer = await userWithRole(owner, 'viewer');
    await as(viewer).get('/message-outbox').expect(200);
    await as(viewer).post(`/message-outbox/${original.id}/resend`).expect(403);

    const again = await as(owner).post(`/message-outbox/${original.id}/resend`).expect(201);
    assert.equal(again.body.data.status, 'sent');
    assert.equal(again.body.data.resentFromId, original.id);
    assert.equal(smtp.sent.filter((m) => m.subject === 'Trip T7 has left').length, 2);
    await as(owner).post('/message-outbox/0123456789abcdef01234567/resend').expect(404);
  });

  test('account e-mails go through the e-mail connection, but their one-time links are never kept or resent', async () => {
    await emailConnection();
    await api().post('/api/v1/auth/forgot-password').send({ email: owner.email }).expect(200);
    const mail = smtp.sent.find((m) => m.to === owner.email)!;
    assert.match(mail.text, /#reset=/);
    const record = (await as(owner).get('/message-outbox', { event: 'account' })).body.data[0];
    assert.equal(record.status, 'sent');
    assert.ok(!record.body.includes('#reset='), 'the link is not kept');
    assert.equal(record.resendable, false);
    const refused = await as(owner).post(`/message-outbox/${record.id}/resend`).expect(409);
    assert.match(refused.body.error.message, /one-time link/);
  });
});
