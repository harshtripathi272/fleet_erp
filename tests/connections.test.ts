// #59: one registry of connection kinds and providers, the move from message connections and the rate
// feed, signed webhooks, storage that remembers where each file is, and the new adapters.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import mongoose from 'mongoose';
import { z } from 'zod';
import { env } from '../src/config/env.js';
import { KINDS, providersOf, registerProvider, signBody, simulatedProvider, type FileStore, type Position } from '../src/core/connections/index.js';
import { decodePolyline, haversineKm } from '../src/core/connections/providers/routing.js';
import { cloudinaryStore, signCloudinary, signS3 } from '../src/core/connections/providers/storage.js';
import { toCsv } from '../src/core/connections/providers/money.js';
import { setSmtpTransportFactory } from '../src/core/mail/mailer.js';
import { Company } from '../src/modules/company/company.model.js';
import { Connection } from '../src/modules/connections/connection.model.js';
import { onInbound, using } from '../src/modules/connections/connections.service.js';
import { migrateToConnections } from '../src/modules/connections/migrate.js';
import { StoredFile } from '../src/modules/files/file.model.js';
import { feedStatus } from '../src/modules/finance/rateFeed.service.js';
import { senderFor } from '../src/modules/messaging/connections.service.js';
import { Role } from '../src/modules/roles/role.model.js';
import { api, bearer, loadSample, resetDatabase, signUp, startDatabase, stopDatabase, type Session } from './helpers.js';

let owner: Session;
const as = (s: Session) => ({
  get: (path: string) => api().get(`/api/v1${path}`).set(bearer(s)),
  post: (path: string, body?: unknown) => api().post(`/api/v1${path}`).set(bearer(s)).send(body as object),
  patch: (path: string, body: unknown) => api().patch(`/api/v1${path}`).set(bearer(s)).send(body as object),
});

// Uploads stored before any storage connection go to the server's own folder: a fresh one for this file.
env.FILE_STORAGE_DIR = mkdtempSync(join(tmpdir(), 'fleet-files-'));
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
/** Answers outside calls with the given JSON, recording each URL. */
function fakeFetch(answer: (url: string, init?: RequestInit) => { status?: number; body: unknown }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const a = answer(String(url), init);
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

/** A tracker service's stand-in, to prove a provider is one file plus a test. */
registerProvider({
  kind: 'gps', key: 'test-tracker', label: 'Test tracker',
  description: 'Only in tests.',
  fields: z.strictObject({ fleetCode: z.string().min(2), pollMinutes: z.number().int().min(1).max(60).default(5), units: z.enum(['kmh', 'knots']).default('kmh') }),
  labels: { fleetCode: 'Fleet code', 'units.kmh': 'Kilometres per hour' },
  hints: { fleetCode: 'As shown in the tracker portal' },
  secrets: [{ key: 'token', label: 'API token', required: true }],
  test: async (ctx) => ({ ok: true, message: `Fleet ${String(ctx.settings.fleetCode)} reachable with token ${ctx.secret('token')}` }),
  open: () => ({ positions: async () => [] }),
  inbound: async (_ctx, body) => ({ accepted: (body as { n: number }).n }),
});

/** A storage service's stand-in that keeps files in memory. */
const memory = new Map<string, Buffer>();
const memoryStore: FileStore = {
  async put(key, body) { memory.set(key, body); },
  async open(key) { const b = memory.get(key); if (!b) throw new Error('missing'); return (await import('node:stream')).Readable.from(b); },
  async remove(key) { memory.delete(key); },
};
registerProvider({ kind: 'storage', key: 'test-memory', label: 'Memory', fields: z.strictObject({}), test: async () => ({ ok: true, message: 'ok' }), open: () => ({ store: async () => memoryStore }) });

before(startDatabase);
after(stopDatabase);
beforeEach(async () => {
  await resetDatabase();
  owner = await signUp('Owner');
  process.env.CONNECTION_HOOK_SECRET = 'hook-secret-0123456789';
  process.env.CONNECTION_TRACKER_TOKEN = 'tok-9f8e7d';
});

describe('the registry', () => {
  test('every kind has a Simulated stand-in, and the providers the issue asks for', () => {
    // Storage is the exception: a simulated store would lose files, so its stand-in is the server's own storage.
    for (const kind of KINDS.filter((k) => k !== 'storage')) assert.ok(simulatedProvider(kind), `${kind} has no Simulated provider`);
    assert.equal(simulatedProvider('storage'), undefined);
    const keys = (kind: (typeof KINDS)[number]) => providersOf(kind).map((p) => p.key);
    for (const [kind, wanted] of [
      ['email', ['smtp']], ['sms', ['africastalking', 'twilio']], ['whatsapp', ['simulated']], ['rates', ['openexchangerates']],
      ['gps', ['webhook', 'traccar']], ['routing', ['straight-line', 'osrm', 'mapbox', 'google']], ['storage', ['local', 'gcs', 's3', 'cloudinary']], ['accounting', ['csv']],
    ] as const) for (const key of wanted) assert.ok(keys(kind).includes(key), `${kind}: ${key}`);
  });

  test('a provider added in one file appears on the screen with its form drawn from its schema', async () => {
    const kinds = (await as(owner).get('/connection-kinds').expect(200)).body.data as Array<Record<string, any>>;
    assert.deepEqual(kinds.map((k) => k.kind), [...KINDS]);
    const gps = kinds.find((k) => k.kind === 'gps')!;
    assert.equal(gps.via, 'simulated');
    assert.equal(gps.provider.simulated, true);
    const tracker = gps.providers.find((p: { key: string }) => p.key === 'test-tracker');
    assert.deepEqual(tracker.fields.map((f: { key: string }) => f.key), ['fleetCode', 'pollMinutes', 'units']);
    const [code, poll, units] = tracker.fields;
    assert.deepEqual([code.label, code.hint, code.required, code.type], ['Fleet code', 'As shown in the tracker portal', true, 'string']);
    assert.deepEqual([poll.type, poll.default, poll.min, poll.max, poll.required], ['number', 5, 1, 60, false]);
    assert.deepEqual(units.choices, [{ value: 'kmh', label: 'Kilometres per hour' }, { value: 'knots', label: 'Knots' }]);
    assert.deepEqual(tracker.secrets, [{ key: 'token', label: 'API token', required: true }]);
    assert.equal(tracker.inbound, true);
  });

  test('what each kind uses with nothing set up: today’s behaviour', async () => {
    const kinds = Object.fromEntries(((await as(owner).get('/connection-kinds')).body.data as Array<Record<string, any>>).map((k) => [k.kind, k]));
    assert.equal(kinds.rates.via, 'none', 'no rate feed: rates typed in by hand');
    assert.equal(kinds.storage.via, 'server', "the server's FILE_STORAGE");
    assert.equal(kinds.routing.provider.key, 'straight-line');
    for (const kind of ['sms', 'whatsapp', 'gps', 'fuel-cards', 'payouts', 'accounting']) assert.equal(kinds[kind].via, 'simulated', kind);
  });

  test('a non-message connection is tested by its provider; the result is kept, secrets come from the server', async () => {
    const c = (await as(owner).post('/connections', { code: 'TRK', name: 'Trackers', kind: 'gps', provider: 'test-tracker', settings: { fleetCode: 'ACME' }, secrets: { token: 'CONNECTION_TRACKER_TOKEN' }, webhookSecretEnv: 'CONNECTION_HOOK_SECRET' }).expect(201)).body.data;
    assert.deepEqual(c.settings, { fleetCode: 'ACME', pollMinutes: 5, units: 'kmh' }, 'defaults filled in');
    assert.deepEqual(c.secretsSet, { token: true });
    assert.match(c.webhookUrl, new RegExp(`/api/v1/hooks/${c.id}$`));
    const result = (await as(owner).post(`/connections/${c.id}/test`, {}).expect(200)).body.data;
    assert.equal(result.ok, true);
    const stored = (await as(owner).get(`/connections/${c.id}`)).body.data;
    assert.equal(stored.lastTest.ok, true);
    assert.match(stored.lastTest.message, /Fleet ACME/);

    // Settings are checked against the provider: unknown fields and wrong types are refused.
    for (const bad of [{ settings: { fleetCode: 'A' } }, { settings: { fleetCode: 'ACME', colour: 'red' } }]) {
      const r = await as(owner).post('/connections', { code: 'TRK2', name: 'Trackers 2', kind: 'gps', provider: 'test-tracker', secrets: { token: 'CONNECTION_TRACKER_TOKEN' }, webhookSecretEnv: 'CONNECTION_HOOK_SECRET', ...bad });
      assert.equal(r.status, 422, JSON.stringify(bad));
    }
    // A secret or signing secret not named is named from the code (#98): nothing is typed.
    const named = (await as(owner).post('/connections', { code: 'TRK3', name: 'Trackers 3', kind: 'gps', provider: 'test-tracker', settings: { fleetCode: 'ACME' } }).expect(201)).body.data;
    assert.deepEqual([named.secrets.token, named.webhookSecretEnv], ['CONNECTION_TRK3_TOKEN', 'CONNECTION_TRK3_SIGNING_SECRET']);
  });

  test('a failed provider test keeps the error with secrets taken out', async () => {
    process.env.CONNECTION_TRACCAR_PASS = 'traccar-pass-55';
    fakeFetch(() => ({ status: 401, body: { message: 'Bad password traccar-pass-55' } }));
    const c = (await as(owner).post('/connections', { code: 'TRC', name: 'Traccar', kind: 'gps', provider: 'traccar', settings: { baseUrl: 'https://traccar.example.com', user: 'admin' }, secrets: { password: 'CONNECTION_TRACCAR_PASS' } }).expect(201)).body.data;
    const result = (await as(owner).post(`/connections/${c.id}/test`, {}).expect(200)).body.data;
    assert.equal(result.ok, false);
    assert.match(result.note, /Traccar answered 401: Bad password \[hidden\]/);
    const stored = (await as(owner).get(`/connections/${c.id}`)).body.data;
    assert.doesNotMatch(JSON.stringify(stored), /traccar-pass-55/);
  });
});

describe('inbound webhooks', () => {
  const hook = async () => {
    const c = (await as(owner).post('/connections', { code: 'GPS', name: 'Trackers', kind: 'gps', provider: 'webhook', enabled: true, settings: { listPath: 'positions', deviceField: 'imei', timeField: 'ts' }, webhookSecretEnv: 'CONNECTION_HOOK_SECRET' }).expect(201)).body.data;
    return c as { id: string; version: number };
  };
  const call = (id: string, body: string, headers: Record<string, string>) => api().post(`/api/v1/hooks/${id}`).set('Content-Type', 'application/json').set(headers).send(body);
  const signed = (body: string, at = Math.floor(Date.now() / 1000)) => ({ 'X-Signature-Timestamp': String(at), 'X-Signature': signBody('hook-secret-0123456789', String(at), body) });

  test('a signed call is accepted and its positions reach whoever listens; unsigned, badly signed and stale ones are refused', async () => {
    const heard: Position[] = [];
    onInbound(async (kind, _c, result) => { if (kind === 'gps') heard.push(...(result.positions ?? [])); });
    const c = await hook();
    const body = JSON.stringify({ positions: [{ imei: '35000001', lat: -15.41, lng: 28.28, ts: 1793700000, speed: 62 }, { imei: '35000002', lat: 'x', lng: 1, ts: 1 }] });

    const ok = await call(c.id, body, signed(body)).expect(200);
    assert.equal(ok.body.data.accepted, 1, 'the unreadable position is skipped');
    assert.equal(heard[0]!.deviceId, '35000001');
    assert.equal(heard[0]!.at.toISOString(), new Date(1793700000 * 1000).toISOString());

    await call(c.id, body, {}).expect(401);
    await call(c.id, body, { ...signed(body), 'X-Signature': signBody('wrong-secret', signed(body)['X-Signature-Timestamp'], body) }).expect(401);
    await call(c.id, body, signed(body, Math.floor(Date.now() / 1000) - 600)).expect(401);
    const tampered = body.replace('-15.41', '-16.00');
    await call(c.id, tampered, signed(body)).expect(401);
    assert.equal(heard.length, 1, 'refused calls reach nobody');
    const stored = (await as(owner).get(`/connections/${c.id}`)).body.data;
    assert.match(stored.lastError.message, /refused/);
  });

  test('a connection switched off, or one whose provider takes no calls, has no webhook', async () => {
    const c = await hook();
    const body = '{"positions":[]}';
    await as(owner).patch(`/connections/${c.id}`, { version: c.version, enabled: false }).expect(200);
    await call(c.id, body, signed(body)).expect(404);
    const routing = (await as(owner).post('/connections', { code: 'RT', name: 'Routing', kind: 'routing', provider: 'straight-line', enabled: true }).expect(201)).body.data;
    await call(routing.id, body, signed(body)).expect(404);
    await call('not-an-id', body, signed(body)).expect(404);
  });
});

describe('moving what existed onto connections', () => {
  test('message connections, the rate feed and custom roles move with nothing lost, once', async () => {
    await loadSample(owner);
    process.env.MESSAGING_SMTP_PASS = 'smtp-pass-migrate';
    const emailId = new mongoose.Types.ObjectId();
    const waId = new mongoose.Types.ObjectId();
    const db = mongoose.connection.db!;
    await db.collection('messageconnections').insertMany([
      { _id: emailId, code: 'SMTP', name: 'Company SMTP', channel: 'email', provider: 'smtp', enabled: true, host: 'smtp.example.com', port: 465, secure: true, user: 'fleet@example.com', from: 'Fleet <fleet@example.com>', secretEnv: 'MESSAGING_SMTP_PASS', lastTest: { at: new Date(), ok: true, to: 'ops@example.com' }, status: 'active', version: 3, custom: {} },
      { _id: waId, code: 'WA', name: 'WhatsApp', channel: 'whatsapp', provider: 'simulator', enabled: true, status: 'active', version: 1, custom: {} },
    ]);
    await Company.updateOne({}, { $set: { 'rateFeed.provider': 'openexchangerates' } });
    const custom = (await Role.create({ key: 'comms', name: 'Comms', permissions: [{ resource: 'message-connections', actions: ['read', 'update'] }], status: 'active' })) as unknown as { _id: unknown };

    const first = await migrateToConnections();
    assert.equal(first.moved, 3);
    assert.deepEqual(await migrateToConnections(), { moved: 0 }, 'runs once');

    const email = await Connection.findById(emailId).lean() as Record<string, any>;
    assert.deepEqual([email.kind, email.provider, email.enabled, email.version], ['email', 'smtp', true, 3]);
    assert.deepEqual(email.settings, { host: 'smtp.example.com', port: 465, secure: true, user: 'fleet@example.com', from: 'Fleet <fleet@example.com>' });
    assert.deepEqual(email.secrets, { password: 'MESSAGING_SMTP_PASS' });
    assert.equal(email.lastTest.to, 'ops@example.com');
    const wa = await Connection.findById(waId).lean() as Record<string, any>;
    assert.equal(wa.provider, 'simulated');
    const role = await Role.findById(custom._id).lean() as unknown as { permissions: Array<{ resource: string }> };
    assert.deepEqual(role.permissions.map((p) => p.resource), ['connections']);

    // Still works: e-mail goes over the same SMTP server with the password from the environment.
    const used: Array<{ host: string; pass?: string }> = [];
    setSmtpTransportFactory((s) => { used.push(s); return { sendMail: (async () => ({ messageId: '<m@x>' })) as never }; });
    try {
      const sender = await senderFor('email');
      assert.equal(String(sender.connection!._id), String(emailId));
      await sender.send!({ to: 'a@example.com', subject: 'Hi', text: 'Hello' });
      assert.deepEqual([used[0]!.host, used[0]!.pass], ['smtp.example.com', 'smtp-pass-migrate']);
    } finally { setSmtpTransportFactory(null); }
    env.DRIVER_PHONE_SIMULATOR = false;
    try { assert.match((await senderFor('whatsapp')).simulated!, /WhatsApp is not connected yet/); } finally { env.DRIVER_PHONE_SIMULATOR = true; }
    const feed = await feedStatus();
    assert.equal(feed.provider, 'openexchangerates');
    const rates = await Connection.findOne({ kind: 'rates' }).lean() as Record<string, any>;
    assert.deepEqual(rates.secrets, { apiKey: 'RATE_FEED_API_KEY' });
    // A role with the old name could no longer be saved; the moved one can.
    const saved = (await as(owner).get(`/roles/${String(custom._id)}`).expect(200)).body.data;
    await as(owner).patch(`/roles/${String(custom._id)}`, { version: saved.version, name: 'Comms team' }).expect(200);
  });
});

describe('file storage', () => {
  test('switching storage sends new files to the new place and keeps reading older ones from where they are', async () => {
    const pdf = (text: string) => Buffer.from(`%PDF-1.7\n${text}`);
    const upload = (body: Buffer) => api().post('/api/v1/files').set(bearer(owner)).set('Content-Type', 'application/pdf').set('X-File-Name', 'note.pdf').send(body);
    const before = (await upload(pdf('before')).expect(201)).body.data;
    assert.equal((await StoredFile.findById(before.id).lean())!.connectionId, undefined, "the server's own storage");

    const c = (await as(owner).post('/connections', { code: 'MEM', name: 'Memory', kind: 'storage', provider: 'test-memory', enabled: true }).expect(201)).body.data;
    assert.equal((await using('storage')).via, 'connection');
    const afterUpload = (await upload(pdf('after')).expect(201)).body.data;
    assert.equal(String((await StoredFile.findById(afterUpload.id).lean())!.connectionId), c.id);
    assert.equal(memory.size, 1, 'the new file went to the connection');

    for (const [file, text] of [[before, 'before'], [afterUpload, 'after']] as const) {
      const got = await api().get(`/api/v1/files/${file.id}`).set(bearer(owner)).buffer(true).parse((res, done) => { const parts: Buffer[] = []; res.on('data', (d: Buffer) => parts.push(d)); res.on('end', () => done(null, Buffer.concat(parts))); }).expect(200);
      assert.equal((got.body as Buffer).toString(), `%PDF-1.7\n${text}`);
    }
    // Switched off, the connection still holds what it stored.
    await as(owner).patch(`/connections/${c.id}`, { version: c.version, enabled: false }).expect(200);
    await api().get(`/api/v1/files/${afterUpload.id}`).set(bearer(owner)).expect(200);
  });
});

describe('adapters', () => {
  test('routing: straight line by default, OSRM and Google read their answers', async () => {
    const lusaka = { lat: -15.4167, lng: 28.2833 }, kapiri = { lat: -13.9706, lng: 28.6693 };
    const straight = await (await using('routing')).capability.route([lusaka, kapiri]);
    assert.equal(straight.km, Math.round(haversineKm(lusaka, kapiri) * 1.28));
    assert.deepEqual(straight.shape, [[28.2833, -15.4167], [28.6693, -13.9706]]);

    const calls = fakeFetch((url) => url.includes('osrm')
      ? { body: { code: 'Ok', routes: [{ distance: 205300, duration: 10080, geometry: { coordinates: [[28.28, -15.41], [28.67, -13.97]] } }] } }
      : { body: { status: 'OK', routes: [{ legs: [{ distance: { value: 205000 }, duration: { value: 9000 } }], overview_polyline: { points: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' } }] } });
    const osrm = (await as(owner).post('/connections', { code: 'OSRM', name: 'OSRM', kind: 'routing', provider: 'osrm', enabled: true, settings: { baseUrl: 'https://osrm.example.com/' } }).expect(201)).body.data;
    const routed = await (await using('routing')).capability.route([lusaka, kapiri]);
    assert.deepEqual([routed.km, routed.hours], [205.3, 2.8]);
    assert.equal(calls[0]!.url, 'https://osrm.example.com/route/v1/driving/28.2833,-15.4167;28.6693,-13.9706?overview=full&geometries=geojson');
    await as(owner).patch(`/connections/${osrm.id}`, { version: osrm.version, enabled: false }).expect(200);

    process.env.CONNECTION_GOOGLE_KEY = 'g-key';
    await as(owner).post('/connections', { code: 'GOOG', name: 'Google', kind: 'routing', provider: 'google', enabled: true, secrets: { apiKey: 'CONNECTION_GOOGLE_KEY' } }).expect(201);
    const google = await (await using('routing')).capability.route([lusaka, kapiri]);
    assert.equal(google.km, 205);
    assert.match(calls.at(-1)!.url, /key=g-key$/);
    // Google's own example polyline.
    assert.deepEqual(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@'), [[-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252]]);
  });

  test("S3: requests are signed as AWS's own example says", () => {
    // From the AWS S3 documentation, "Example: GET Object".
    const headers = signS3({
      method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'), region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      headers: { Range: 'bytes=0-9' }, now: new Date('2013-05-24T00:00:00Z'),
    });
    assert.equal(headers.authorization, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });

  test("Cloudinary: requests are signed as Cloudinary's own example says", () => {
    // From the Cloudinary documentation, "Generating authentication signatures".
    assert.equal(signCloudinary({ eager: 'w_400,h_300,c_pad|w_260,h_200,c_crop', public_id: 'sample_image', timestamp: 1315060510 }, 'abcd'), 'bfd09f95f331f558cbd1320e67aa8d488770583e');
  });

  test('Cloudinary: a file is stored privately, read back with a signed request, and removed', async () => {
    const calls = fakeFetch((url) => (url.includes('/download') && url.includes('missing') ? { status: 404, body: { error: { message: 'Resource not found' } } } : { body: url.includes('/download') ? 'file bytes' : { result: 'ok' } }));
    const store = cloudinaryStore({ cloudName: 'demo-cloud', folder: 'fleet' }, { apiKey: '1234', apiSecret: 'shh' }, () => 1700000000);
    await store.put('2026-11/a.pdf', Buffer.from('%PDF-1.7'), 'application/pdf');
    const upload = calls[0]!;
    assert.equal(upload.url, 'https://api.cloudinary.com/v1_1/demo-cloud/raw/upload');
    const form = upload.init!.body as FormData;
    assert.equal(form.get('public_id'), 'fleet/2026-11/a.pdf');
    assert.equal(form.get('type'), 'private', 'nobody reads it without a signature');
    assert.equal(form.get('api_key'), '1234');
    assert.equal(form.get('signature'), signCloudinary({ overwrite: 'false', public_id: 'fleet/2026-11/a.pdf', timestamp: 1700000000, type: 'private' }, 'shh'));
    assert.equal(Buffer.from(await (form.get('file') as Blob).arrayBuffer()).toString(), '%PDF-1.7');

    const read = await store.open('2026-11/a.pdf');
    const parts: Buffer[] = [];
    for await (const part of read) parts.push(Buffer.from(part));
    assert.equal(Buffer.concat(parts).toString(), '"file bytes"');
    const download = new URL(calls[1]!.url);
    assert.equal(download.pathname, '/v1_1/demo-cloud/raw/download');
    assert.equal(download.searchParams.get('signature'), signCloudinary({ public_id: 'fleet/2026-11/a.pdf', timestamp: 1700000000, type: 'private' }, 'shh'));
    await assert.rejects(store.open('missing.pdf'), /File not found/);

    await store.remove('2026-11/a.pdf');
    assert.equal(calls.at(-1)!.url, 'https://api.cloudinary.com/v1_1/demo-cloud/raw/destroy');
    assert.equal(new URLSearchParams(String(calls.at(-1)!.init!.body)).get('public_id'), 'fleet/2026-11/a.pdf');
  });

  test('SMS: Twilio and Africa’s Talking are called with the key from the environment', async () => {
    env.DRIVER_PHONE_SIMULATOR = false;
    process.env.CONNECTION_TWILIO_TOKEN = 'twilio-token-1';
    try {
      const calls = fakeFetch(() => ({ status: 201, body: { sid: 'SM123' } }));
      const sid = `AC${'a'.repeat(32)}`;
      await as(owner).post('/connections', { code: 'TW', name: 'Twilio', kind: 'sms', provider: 'twilio', enabled: true, settings: { accountSid: sid, from: '+15551234567' }, secrets: { authToken: 'CONNECTION_TWILIO_TOKEN' } }).expect(201);
      const sent = await (await senderFor('sms')).send!({ to: '+260971234567', text: 'Hello' });
      assert.equal(sent.providerRef, 'SM123');
      assert.equal(calls[0]!.url, `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`);
      assert.equal((calls[0]!.init!.headers as Record<string, string>).authorization, `Basic ${Buffer.from(`${sid}:twilio-token-1`).toString('base64')}`);
      assert.equal(String(calls[0]!.init!.body), 'To=%2B260971234567&Body=Hello&From=%2B15551234567');
    } finally { env.DRIVER_PHONE_SIMULATOR = true; }
  });

  test('accounting CSV: quoted where needed, formulas defused', () => {
    assert.equal(toCsv(['a', 'b'], [{ a: 'Kurasini, Dar', b: '=SUM(A1)' }, { a: 'say "hi"', b: -5 }]), 'a,b\r\n"Kurasini, Dar",\'=SUM(A1)\r\n"say ""hi""",-5\r\n');
    assert.equal(toCsv(['a'], [{ a: '1,5' }], ';'), 'a\r\n1,5\r\n');
  });
});
