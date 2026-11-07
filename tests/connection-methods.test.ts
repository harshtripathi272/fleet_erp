// #98: real WhatsApp and e-mail methods, each with a guide; keys never typed, their settings named from the code;
// test before saving. No live account: every outside service answers from a recorded reply.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { env } from '../src/config/env.js';
import { providerFor, providersOf, secretEnvName, secretSetup } from '../src/core/connections/index.js';
import { smtpServer } from '../src/core/connections/providers/messages.js';
import { CARRIER_TEMPLATE, asTemplateText, metaMessages, twilioSignature } from '../src/core/connections/providers/whatsapp.js';
import { splitAddress } from '../src/core/connections/providers/email.js';
import { Connection } from '../src/modules/connections/connection.model.js';
import { DriverDocument } from '../src/modules/operations/models/cargo.model.js';
import { api, bearer, loadSample, resetDatabase, signUp, startDatabase, stopDatabase, type Session } from './helpers.js';
import { fetchMedia } from '../src/core/connections/providers/whatsapp.js';

let owner: Session;
const as = (s: Session) => ({
  get: (path: string, query: Record<string, string> = {}) => api().get(`/api/v1${path}`).query(query).set(bearer(s)),
  post: (path: string, body?: unknown) => api().post(`/api/v1${path}`).set(bearer(s)).send(body as object),
});

/** Records every outside call and answers it with the reply given for its address. */
type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };
const realFetch = globalThis.fetch;
function recordFetch(answer: (url: string, init: RequestInit) => Reply) {
  const calls: Array<{ url: string; init: RequestInit; json?: any }> = [];
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const call = { url: String(url), init, json: typeof init.body === 'string' ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const a = answer(call.url, init);
    return new Response(a.body === undefined ? null : JSON.stringify(a.body), { status: a.status ?? 200, headers: { 'content-type': 'application/json', ...a.headers } });
  }) as typeof fetch;
  return calls;
}
afterEach(() => { globalThis.fetch = realFetch; });

const SECRETS = { CONNECTION_WA_ACCESS_TOKEN: 'EAAG-test-token', CONNECTION_WA_APP_SECRET: 'meta-app-secret-123', CONNECTION_WA_VERIFY_TOKEN: 'verify-me-please-42', CONNECTION_TW_AUTH_TOKEN: 'twilio-auth-token-99', CONNECTION_SG_API_KEY: 'SG.test-key' };

before(startDatabase);
after(stopDatabase);
beforeEach(async () => {
  await resetDatabase();
  owner = await signUp('Owner');
  Object.assign(process.env, SECRETS);
  env.DRIVER_PHONE_SIMULATOR = false;
});
afterEach(() => { for (const k of Object.keys(SECRETS)) delete process.env[k]; env.DRIVER_PHONE_SIMULATOR = true; });

const meta = (extra: Record<string, unknown> = {}) => ({
  code: 'WA', name: 'WhatsApp', kind: 'whatsapp', provider: 'meta', enabled: true,
  settings: { phoneNumberId: '109876543210', businessAccountId: '204567890123', ...extra },
});

describe('guides and names', () => {
  test('every message provider has a guide; Marichi Talks is listed as Coming soon', async () => {
    for (const kind of ['email', 'sms', 'whatsapp'] as const) {
      for (const p of providersOf(kind).filter((x) => !x.simulated && !x.comingSoon)) assert.ok((p.guide ?? []).length >= 2, `${kind}/${p.key} has a guide`);
    }
    const kinds = (await as(owner).get('/connection-kinds').expect(200)).body.data as Array<{ kind: string; providers: Array<{ key: string; guide: unknown[]; comingSoon?: string; ownSignature: boolean }> }>;
    const whatsapp = kinds.find((k) => k.kind === 'whatsapp')!;
    assert.deepEqual(whatsapp.providers.map((p) => p.key).sort(), ['marichi-talks', 'meta', 'simulated', 'twilio']);
    assert.equal(whatsapp.providers.find((p) => p.key === 'marichi-talks')!.comingSoon, undefined, 'it can be connected');
    assert.ok(whatsapp.providers.find((p) => p.key === 'meta')!.ownSignature);
    assert.match(JSON.stringify(whatsapp.providers.find((p) => p.key === 'meta')!.guide), /\{webhookUrl\}/);
    // Marichi Talks connects like any other: it needs its address, and then it's saved and sends.
    await as(owner).post('/connections', { code: 'MT', name: 'Marichi Talks', kind: 'whatsapp', provider: 'marichi-talks' }).expect(422);
    const talks = (await as(owner).post('/connections', { code: 'MT', name: 'Marichi Talks', kind: 'whatsapp', provider: 'marichi-talks', settings: { address: 'https://talks.example.com/api/' } }).expect(201)).body.data;
    assert.equal(talks.secrets.apiKey, 'CONNECTION_MT_API_KEY');
    assert.equal(talks.webhookSecretEnv, 'CONNECTION_MT_SIGNING_SECRET');
    const provider = providersOf('whatsapp').find((p) => p.key === 'marichi-talks')!;
    const realFetch = globalThis.fetch;
    let sent: { url: string; body: Record<string, unknown>; auth?: string } | undefined;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent = { url: String(url), body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).authorization };
      return new Response(JSON.stringify({ id: 'mt-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const sender = provider.open({ settings: { address: 'https://talks.example.com/api/' }, secret: () => 'the-key' } as never) as { send(m: { to: string; text: string }): Promise<{ providerRef?: string }> };
      assert.equal((await sender.send({ to: '+260971234567', text: 'Hello' })).providerRef, 'mt-1');
      assert.equal(sent!.url, 'https://talks.example.com/api/messages');
      assert.equal(sent!.auth, 'Bearer the-key');
      assert.deepEqual(sent!.body, { to: '+260971234567', text: 'Hello' });
    } finally { globalThis.fetch = realFetch; }
    const replies = await (provider.inbound as (c: unknown, b: unknown) => Promise<{ accepted: number; messages?: { from: string; text?: string }[] }>)({}, { messages: [{ from: '260971234567', text: 'Loaded', id: 'r1' }] });
    assert.equal(replies.messages![0]!.from, '+260971234567');
  });

  test('settings are named from the code, never typed; only our own webhooks get a signing secret', async () => {
    assert.equal(secretEnvName('WA', 'accessToken'), 'CONNECTION_WA_ACCESS_TOKEN');
    assert.equal(secretEnvName('fleet-mail 2', 'apiKey'), 'CONNECTION_FLEET_MAIL_2_API_KEY');
    const created = (await as(owner).post('/connections', meta()).expect(201)).body.data;
    assert.deepEqual(created.secrets, { accessToken: 'CONNECTION_WA_ACCESS_TOKEN', appSecret: 'CONNECTION_WA_APP_SECRET', verifyToken: 'CONNECTION_WA_VERIFY_TOKEN' });
    assert.equal(created.webhookSecretEnv, undefined, 'Meta signs its own calls');
    assert.match(created.webhookUrl, /\/api\/v1\/hooks\/[0-9a-f]{24}$/);
    const tracker = (await as(owner).post('/connections', { code: 'TRK', name: 'Trackers', kind: 'gps', provider: 'webhook', settings: { deviceField: 'imei', latField: 'lat', lngField: 'lng', timeField: 'time' } }).expect(201)).body.data;
    assert.equal(tracker.webhookSecretEnv, 'CONNECTION_TRK_SIGNING_SECRET');
  });

  test('each platform gets the commands that set the keys, with <value> where the key goes', async () => {
    const names = ['CONNECTION_WA_ACCESS_TOKEN'];
    assert.match(secretSetup(names, 'fly', 'acme').steps[0]!.command!, /^fly secrets set CONNECTION_WA_ACCESS_TOKEN='<value>' --app fleet-acme$/);
    assert.match(secretSetup(names, 'gcp', 'acme').steps[0]!.command!, /CONNECTION_WA_ACCESS_TOKEN='<value>' deploy\/gcp\.sh <version>/);
    assert.match(secretSetup(names, 'compose').steps[1]!.command!, /docker compose up -d/);
    const setup = (await as(owner).get('/connection-secret-setup', { kind: 'email', provider: 'sendgrid', code: 'SG', target: 'env' }).expect(200)).body.data;
    assert.deepEqual(setup.names, [{ name: 'CONNECTION_SG_API_KEY', set: true }]);
    assert.ok(!JSON.stringify(setup).includes(SECRETS.CONNECTION_SG_API_KEY), 'the value never comes back');
  });
});

describe('test before saving', () => {
  test('a key not set yet is named; a simulated provider says so; bad settings are refused', async () => {
    delete process.env.CONNECTION_WA_ACCESS_TOKEN;
    const missing = (await as(owner).post('/connections/test-draft', { kind: 'whatsapp', provider: 'meta', code: 'WA', settings: meta().settings, to: '+260971234567' }).expect(200)).body.data;
    assert.deepEqual([missing.ok, missing.missing], [false, ['CONNECTION_WA_ACCESS_TOKEN']]);
    const simulated = (await as(owner).post('/connections/test-draft', { kind: 'sms', provider: 'simulated', to: '+260971234567' }).expect(200)).body.data;
    assert.deepEqual([simulated.ok, simulated.simulated], [true, true]);
    await as(owner).post('/connections/test-draft', { kind: 'whatsapp', provider: 'meta', settings: { phoneNumberId: 'abc' }, to: '+260971234567' }).expect(422);
    assert.equal(await Connection.countDocuments(), 0, 'nothing is stored');
  });

  test('a real service: the test message goes out and its answer is shown', async () => {
    const calls = recordFetch(() => ({ body: { messages: [{ id: 'wamid.TEST1' }] } }));
    const result = (await as(owner).post('/connections/test-draft', { kind: 'whatsapp', provider: 'meta', code: 'WA', settings: meta().settings, to: '+260 97 123 4567' }).expect(200)).body.data;
    assert.ok(result.ok, result.message);
    assert.match(result.message, /wamid\.TEST1/);
    assert.equal(calls[0]!.url, 'https://graph.facebook.com/v21.0/109876543210/messages');
    assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, `Bearer ${SECRETS.CONNECTION_WA_ACCESS_TOKEN}`);
    assert.deepEqual([calls[0]!.json.to, calls[0]!.json.type], ['260971234567', 'text']);
    recordFetch(() => ({ status: 401, body: { error: { code: 190, message: 'Invalid OAuth access token' } } }));
    const failed = (await as(owner).post('/connections/test-draft', { kind: 'whatsapp', provider: 'meta', code: 'WA', settings: meta().settings, to: '+260971234567' }).expect(200)).body.data;
    assert.deepEqual([failed.ok, /Invalid OAuth access token/.test(failed.message)], [false, true]);
  });
});

describe('WhatsApp', () => {
  test('Meta: outside the 24 hours the message goes through the one approved template, or says what to do', async () => {
    const ctx = (templateName?: string) => ({ settings: { ...meta().settings, apiVersion: 'v21.0', templateLanguage: 'en', ...(templateName ? { templateName } : {}) }, secret: (k: string) => (k === 'accessToken' ? 'tok' : undefined) });
    const calls = recordFetch((_url, init) => (JSON.parse(String(init.body)).type === 'text' ? { status: 400, body: { error: { code: 131047, message: 'Re-engagement message' } } } : { body: { messages: [{ id: 'wamid.T2' }] } }));
    const sender = providerFor('whatsapp', 'meta')!.open(ctx(CARRIER_TEMPLATE.name) as never) as { send: (m: { to: string; text: string }) => Promise<{ providerRef?: string }> };
    assert.equal((await sender.send({ to: '+260971234567', text: 'Trip TRIP/26/0001\nhas left.' })).providerRef, 'wamid.T2');
    assert.equal(calls[1]!.json.template.name, 'fleet_update');
    assert.deepEqual(calls[1]!.json.template.components[0].parameters, [{ type: 'text', text: 'Trip TRIP/26/0001 · has left.' }]);
    const without = providerFor('whatsapp', 'meta')!.open(ctx() as never) as typeof sender;
    await assert.rejects(without.send({ to: '+260971234567', text: 'Hello' }), /approved templates.*fleet_update/);
    assert.equal(asTemplateText('a\n\nb    c'), 'a · b   c');
  });

  test('Meta: the address check is answered, and a signed reply from a driver reaches the app', async () => {
    await loadSample(owner);
    const wa = (await as(owner).post('/connections', meta()).expect(201)).body.data;
    const hook = `/api/v1/hooks/${wa.id}`;
    const challenge = await api().get(hook).query({ 'hub.mode': 'subscribe', 'hub.verify_token': SECRETS.CONNECTION_WA_VERIFY_TOKEN, 'hub.challenge': '1158201444' }).expect(200);
    assert.equal(challenge.text, '1158201444');
    await api().get(hook).query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' }).expect(401);

    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{ from: '260971234567', id: 'wamid.IN1', timestamp: '1793900000', type: 'text', text: { body: 'Arrived at the border, queue is long' } }] } }] }] });
    const sign = (secret: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    await api().post(hook).set('content-type', 'application/json').set('x-hub-signature-256', sign('not-the-secret')).send(body).expect(401);
    const ok = await api().post(hook).set('content-type', 'application/json').set('x-hub-signature-256', sign(SECRETS.CONNECTION_WA_APP_SECRET)).send(body).expect(200);
    assert.equal(ok.body.data.accepted, 1);
    const doc = await DriverDocument.findOne({ note: 'Arrived at the border, queue is long' }).lean();
    assert.ok(doc, 'the reply is filed for the driver');
    assert.equal(metaMessages({ entry: [{ changes: [{ value: { statuses: [{ id: 'x' }] } }] }] }).length, 0, 'delivery receipts are not messages');
  });

  test('Twilio: its own signature is checked, form replies are read, and the template goes after 24 hours', async () => {
    await loadSample(owner);
    const tw = (await as(owner).post('/connections', { code: 'TW', name: 'Twilio WhatsApp', kind: 'whatsapp', provider: 'twilio', enabled: true, settings: { accountSid: `AC${'1'.repeat(32)}`, from: '+14155238886', contentSid: `HX${'a'.repeat(32)}` } }).expect(201)).body.data;
    const fields = { From: 'whatsapp:+260971234567', Body: 'Loading done', MessageSid: 'SM1', NumMedia: '0' };
    const form = new URLSearchParams(fields).toString();
    const signature = twilioSignature(SECRETS.CONNECTION_TW_AUTH_TOKEN, tw.webhookUrl, fields);
    await api().post(`/api/v1/hooks/${tw.id}`).set('content-type', 'application/x-www-form-urlencoded').set('x-twilio-signature', 'bad').send(form).expect(401);
    await api().post(`/api/v1/hooks/${tw.id}`).set('content-type', 'application/x-www-form-urlencoded').set('x-twilio-signature', signature).send(form).expect(200);
    assert.ok(await DriverDocument.exists({ note: 'Loading done' }));

    const calls = recordFetch((_url, init) => (new URLSearchParams(String(init.body)).has('Body') ? { status: 400, body: { code: 63016, message: 'Outside the allowed window' } } : { status: 201, body: { sid: 'SM2' } }));
    const sender = providerFor('whatsapp', 'twilio')!.open({ settings: { accountSid: `AC${'1'.repeat(32)}`, from: '+14155238886', contentSid: `HX${'a'.repeat(32)}` }, secret: () => 'tok' } as never) as { send: (m: { to: string; text: string }) => Promise<{ providerRef?: string }> };
    assert.equal((await sender.send({ to: '+260971234567', text: 'Hello\nthere' })).providerRef, 'SM2');
    const second = new URLSearchParams(String(calls[1]!.init.body));
    assert.deepEqual([second.get('To'), second.get('ContentSid'), second.get('ContentVariables')], ['whatsapp:+260971234567', `HX${'a'.repeat(32)}`, JSON.stringify({ 1: 'Hello · there' })]);
  });
});

describe('e-mail', () => {
  test('SMTP presets fill the server; SES needs its region', () => {
    assert.deepEqual(smtpServer({ preset: 'google', from: 'x@y.z' }), { host: 'smtp.gmail.com', port: 587, secure: false });
    assert.equal(smtpServer({ preset: 'ses', region: 'af-south-1', from: 'x@y.z' }).host, 'email-smtp.af-south-1.amazonaws.com');
    assert.equal(smtpServer({ preset: 'google', host: 'smtp-relay.gmail.com', port: 465, secure: true, from: 'x@y.z' }).port, 465);
    const fields = providerFor('email', 'smtp')!.fields;
    assert.ok(!fields.safeParse({ preset: 'ses', user: 'u', from: 'x@y.z' }).success, 'SES without a region');
    assert.ok(!fields.safeParse({ preset: 'other', from: 'x@y.z' }).success, 'another server without a host');
    assert.ok(fields.safeParse({ preset: 'microsoft', user: 'fleet@acme.example', from: 'Acme <fleet@acme.example>' }).success);
  });

  test('SendGrid, Resend and Mailgun are called as their APIs expect', async () => {
    assert.deepEqual(splitAddress('Acme Haulage <fleet@acme.example>'), { name: 'Acme Haulage', email: 'fleet@acme.example' });
    const message = { to: 'ops@acme.example', subject: 'Test', text: 'Hello', attachments: [{ filename: 'a.txt', content: Buffer.from('hi'), contentType: 'text/plain' }] };
    const ctx = (settings: Record<string, unknown>) => ({ settings, secret: () => 'key-123' }) as never;

    let calls = recordFetch(() => ({ status: 202, headers: { 'x-message-id': 'sg-1' } }));
    assert.equal((await (providerFor('email', 'sendgrid')!.open(ctx({ from: 'Acme <fleet@acme.example>' })) as any).send(message)).providerRef, 'sg-1');
    assert.equal(calls[0]!.url, 'https://api.sendgrid.com/v3/mail/send');
    assert.deepEqual(calls[0]!.json.from, { name: 'Acme', email: 'fleet@acme.example' });
    assert.equal(calls[0]!.json.attachments[0].content, Buffer.from('hi').toString('base64'));

    calls = recordFetch(() => ({ body: { id: 're-1' } }));
    assert.equal((await (providerFor('email', 'resend')!.open(ctx({ from: 'fleet@acme.example' })) as any).send(message)).providerRef, 're-1');
    assert.deepEqual([calls[0]!.url, calls[0]!.json.to], ['https://api.resend.com/emails', ['ops@acme.example']]);

    calls = recordFetch(() => ({ body: { id: '<mg-1@acme>', message: 'Queued' } }));
    assert.equal((await (providerFor('email', 'mailgun')!.open(ctx({ domain: 'mg.acme.example', region: 'eu', from: 'fleet@acme.example' })) as any).send(message)).providerRef, '<mg-1@acme>');
    assert.equal(calls[0]!.url, 'https://api.eu.mailgun.net/v3/mg.acme.example/messages');
    assert.equal((calls[0]!.init.body as FormData).get('to'), 'ops@acme.example');
    assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, `Basic ${Buffer.from('api:key-123').toString('base64')}`);
  });

  test('a photo is only fetched from the service itself, over https, and within the upload limit', async () => {
    await assert.rejects(fetchMedia('Meta', 'https://attacker.example/photo', ['fbsbx.com'], {}), /outside its own service/);
    await assert.rejects(fetchMedia('Meta', 'https://fbsbx.com.attacker.example/photo', ['fbsbx.com'], {}), /outside its own service/, 'a look-alike host');
    await assert.rejects(fetchMedia('Meta', 'http://lookaside.fbsbx.com/photo', ['fbsbx.com'], {}), /outside its own service/, 'never over plain http');
    const realFetch = globalThis.fetch;
    const limit = env.UPLOAD_MAX_MB;
    env.UPLOAD_MAX_MB = 1;
    try {
      globalThis.fetch = (async () => new Response(new Uint8Array(2 * 1048576))) as typeof fetch;
      await assert.rejects(fetchMedia('Meta', 'https://lookaside.fbsbx.com/photo', ['fbsbx.com'], {}), /larger than this app accepts/);
      globalThis.fetch = (async () => new Response(new Uint8Array(3), { headers: { 'content-type': 'image/png' } })) as typeof fetch;
      const ok = await fetchMedia('Meta', 'https://lookaside.fbsbx.com/photo', ['fbsbx.com'], {});
      assert.equal(ok.body.length, 3);
      assert.equal(ok.mime, 'image/png');
    } finally { globalThis.fetch = realFetch; env.UPLOAD_MAX_MB = limit; }
  });
});
