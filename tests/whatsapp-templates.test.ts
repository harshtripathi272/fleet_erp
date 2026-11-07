// #112: every WhatsApp message the app sends has a Meta template ready to approve; they can be submitted and
// tracked; sending picks the right one; a driver's photo over WhatsApp is kept. No live Meta account: every
// call to Meta answers from a recorded reply.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { env } from '../src/config/env.js';
import { WA_TEMPLATES, metaDefinition, ruleProblems, waTemplate } from '../src/modules/messaging/whatsapp/templates.js';
import { WaContact, WaTemplateState } from '../src/modules/messaging/whatsapp/state.js';
import { DriverDocument } from '../src/modules/operations/models/cargo.model.js';
import { Connection } from '../src/modules/connections/connection.model.js';
import { api, bearer, find, loadSample, resetDatabase, signUp, startDatabase, stopDatabase, userWithRole, type Session } from './helpers.js';

const OPS = join(import.meta.dirname, '..', 'src', 'modules', 'operations');

/** The text of each `post(...)` call, from its opening parenthesis to the matching one. */
function postCalls(source: string) {
  const out: string[] = [];
  for (let at = source.indexOf('post('); at >= 0; at = source.indexOf('post(', at + 5)) {
    if (/[\w.]$/.test(source.slice(at - 1, at)) && !/\s|\(|;|\{/.test(source[at - 1]!)) continue;
    let depth = 0;
    let end = at + 4;
    for (; end < source.length; end++) {
      if (source[end] === '(') depth++;
      else if (source[end] === ')' && --depth === 0) break;
    }
    out.push(source.slice(at, end + 1));
  }
  return out;
}

describe('the template pack', () => {
  test('every template keeps to Meta\'s rules, and none is Marketing', () => {
    for (const t of WA_TEMPLATES) assert.deepEqual(ruleProblems(t), [], t.name);
    assert.equal(new Set(WA_TEMPLATES.map((t) => t.name)).size, WA_TEMPLATES.length, 'names are unique');
    const definition = metaDefinition(waTemplate('trip_assigned')!) as { components: Array<{ type: string; example?: unknown }> };
    assert.deepEqual(definition.components.map((c) => c.type), ['HEADER', 'BODY', 'FOOTER']);
    assert.ok(definition.components.every((c) => c.type === 'FOOTER' || c.example), 'samples for every variable');
  });

  test('no WhatsApp message the app sends is left without a template', () => {
    const used = new Set<string>();
    for (const file of readdirSync(OPS).filter((f) => f.endsWith('.ts'))) {
      const source = readFileSync(join(OPS, file), 'utf8');
      for (const call of postCalls(source)) {
        const outbound = /^post\(driverThread\(/.test(call) ? !/from: 'me'/.test(call) : /^post\(customerThread\(/.test(call) ? !/from: 'contact'/.test(call) : false;
        const named = /wa: \{ template: '([a-z_]+)'/.exec(call)?.[1];
        if (named) used.add(named);
        if (outbound) assert.ok(named, `${file}: a message to WhatsApp names no template:\n${call.slice(0, 160)}`);
      }
      for (const m of source.matchAll(/template: '([a-z_]+)', values/g)) used.add(m[1]!);
    }
    // The office's own messages, and an approver's buttons, carry theirs too.
    assert.match(readFileSync(join(OPS, 'messages.service.ts'), 'utf8'), /template: 'office_message'/);
    assert.match(readFileSync(join(OPS, 'actionTokens.ts'), 'utf8'), /template: 'approval_request'/);
    for (const name of used) assert.ok(waTemplate(name), `${name} is in the pack`);
    // And every template in the pack is used by something (the company's own messages use the last two).
    const unused = WA_TEMPLATES.map((t) => t.name).filter((n) => !used.has(n) && !['advance_request', 'fleet_update'].includes(n));
    assert.deepEqual(unused, []);
  });
});

/* ---------- Against a recorded Meta ---------- */

type Call = { url: string; method: string; json?: any };
const realFetch = globalThis.fetch;
function recordMeta(answer: (call: Call) => { status?: number; body?: unknown; raw?: Buffer; headers?: Record<string, string> }) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', json: typeof init.body === 'string' ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const a = answer(call);
    if (a.raw) return new Response(new Uint8Array(a.raw), { status: a.status ?? 200, headers: a.headers });
    return new Response(a.body === undefined ? null : JSON.stringify(a.body), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}
afterEach(() => { globalThis.fetch = realFetch; });

const SECRETS = { CONNECTION_WA_ACCESS_TOKEN: 'EAAG-test', CONNECTION_WA_APP_SECRET: 'app-secret-xyz', CONNECTION_WA_VERIFY_TOKEN: 'verify-123' };
let owner: Session;
const as = (s: Session) => ({
  get: (path: string) => api().get(`/api/v1${path}`).set(bearer(s)),
  post: (path: string, body: unknown = {}) => api().post(`/api/v1${path}`).set(bearer(s)).send(body as object),
  patch: (path: string, body: unknown) => api().patch(`/api/v1${path}`).set(bearer(s)).send(body as object),
});

before(startDatabase);
after(stopDatabase);
beforeEach(async () => {
  await resetDatabase();
  owner = await signUp('Owner');
  Object.assign(process.env, SECRETS);
  env.DRIVER_PHONE_SIMULATOR = false;
});
afterEach(() => { for (const k of Object.keys(SECRETS)) delete process.env[k]; env.DRIVER_PHONE_SIMULATOR = true; });

async function connectMeta() {
  return (await as(owner).post('/connections', { code: 'WA', name: 'WhatsApp', kind: 'whatsapp', provider: 'meta', enabled: true, settings: { phoneNumberId: '109876543210', businessAccountId: '204567890123' } }).expect(201)).body.data;
}

describe('submitting and tracking', () => {
  test('every template is listed with its text filled in; submitted with the connection\'s key; its standing read back', async () => {
    const before = (await as(owner).get('/whatsapp-templates').expect(200)).body.data;
    assert.equal(before.connection, null, 'no real WhatsApp connection yet');
    assert.equal(before.templates.length, WA_TEMPLATES.length);
    await connectMeta();
    const listed = (await as(owner).get('/whatsapp-templates').expect(200)).body.data;
    const trip = listed.templates.find((t: { name: string }) => t.name === 'trip_assigned');
    assert.equal(trip.preview, 'You have a new trip, TRIP/26/0012: truck ALC 4821 for Zambezi Energy Ltd, Dar es Salaam port to Lusaka fuel depot. It starts 6 Nov, 06:00; the office will confirm before you leave.');
    assert.equal(trip.status, 'not_submitted');

    const calls = recordMeta((c) => (c.method === 'POST' ? (c.json.name === 'trip_closed' ? { status: 400, body: { error: { code: 100, message: 'Template name already exists' } } } : { body: { id: `t-${c.json.name}`, status: 'PENDING' } })
      : { body: { data: [{ name: 'trip_assigned', language: 'en', status: 'APPROVED', id: 't-1' }, { name: 'trip_closed', language: 'en', status: 'REJECTED', rejected_reason: 'INVALID_FORMAT', id: 't-2' }] } }));
    const submitted = (await as(owner).post('/whatsapp-templates/submit').expect(200)).body.data;
    const posted = calls.filter((c) => c.method === 'POST');
    assert.equal(posted.length, WA_TEMPLATES.length);
    assert.equal(posted[0]!.url, 'https://graph.facebook.com/v21.0/204567890123/message_templates');
    assert.deepEqual(posted.find((c) => c.json.name === 'money_issued')!.json, metaDefinition(waTemplate('money_issued')!));
    assert.equal(submitted.results.find((r: { name: string }) => r.name === 'trip_closed').ok, false);
    const states = new Map((submitted.templates as Array<{ name: string; status: string; reason?: string }>).map((t) => [t.name, t]));
    assert.equal(states.get('trip_assigned')!.status, 'approved', 'read back from Meta after a refusal');
    assert.deepEqual([states.get('trip_closed')!.status, states.get('trip_closed')!.reason], ['rejected', 'INVALID_FORMAT']);
    assert.equal(states.get('money_issued')!.status, 'pending');
  });

  test('the pack downloads as Meta\'s JSON and as a document to submit by hand', async () => {
    const json = (await as(owner).get('/whatsapp-templates/export.json').expect(200)).body;
    assert.equal(json.length, WA_TEMPLATES.length);
    const doc = (await as(owner).get('/whatsapp-templates/export.md').expect(200)).text;
    assert.match(doc, /## trip_dispatched/);
    assert.match(doc, /sample for \{\{6\}\}: 5,340 ZMW/);
  });
});

describe('sending picks the right one', () => {
  let ops: Session;
  let ids: Record<string, string>;
  beforeEach(async () => {
    await loadSample(owner);
    ops = await userWithRole(owner, 'operations');
    ids = {};
    for (const [key, master, search] of [['zambezi', 'parties', 'Zambezi'], ['v1', 'vehicles', 'ALC 4821'], ['d1', 'drivers', 'Joseph'], ['routeDar', 'routes', 'DAR-LSK'], ['depot', 'places', 'LSK-DEPOT']] as const) ids[key] = (await find(owner, master, search)).id;
    await connectMeta();
  });
  const newTrip = () => as(ops).post('/trips', { customerId: ids.zambezi, vehicleId: ids.v1, driverId: ids.d1, routeId: ids.routeDar, plannedStart: '2026-11-08T06:00:00.000Z' });
  const sent = (calls: Call[]) => calls.filter((c) => c.url.endsWith('/messages')).map((c) => c.json);

  test('outside the 24 hours: the message\'s approved template, with the company in the header', async () => {
    const connection = await Connection.findOne({ code: 'WA' }).lean();
    await WaTemplateState.create({ connectionId: connection!._id, name: 'trip_assigned', language: 'en', status: 'approved' });
    const calls = recordMeta(() => ({ body: { messages: [{ id: 'wamid.T1' }] } }));
    await newTrip().expect(201);
    const [message] = sent(calls);
    assert.equal(message.type, 'template');
    assert.equal(message.template.name, 'trip_assigned');
    assert.equal(message.template.components[0].parameters[0].text, 'Marichi Fleet', 'the company, from its brand');
    assert.equal(message.template.components[1].parameters[1].text, 'ALC 4821');
  });

  test('within the 24 hours: as written; with nothing approved, WhatsApp\'s refusal names the template to get approved', async () => {
    await WaContact.create({ phone: '260971234567', lastInboundAt: new Date() });
    let calls = recordMeta(() => ({ body: { messages: [{ id: 'wamid.T2' }] } }));
    await newTrip().expect(201);
    assert.equal(sent(calls)[0].type, 'text');
    assert.match(sent(calls)[0].text.body, /^\*New trip TRIP\/26\/\d{4}\*\n/);

    await WaContact.deleteMany({});
    calls = recordMeta(() => ({ status: 400, body: { error: { code: 131047, message: 'Re-engagement message' } } }));
    const trip = (await as(ops).get('/trips?state=planned').expect(200)).body.data[0];
    await as(ops).post(`/trips/${trip.id}/cancel`, { reason: 'Customer changed the date' });
    const thread = (await as(ops).get(`/messages?thread=driver:${ids.d1}`).expect(200)).body.data as Array<{ text: string; delivery?: { status: string; error?: string } }>;
    const cancelled = thread.find((m) => /is cancelled/.test(m.text));
    assert.equal(cancelled?.delivery?.status, 'failed');
    assert.match(cancelled!.delivery!.error!, /submit the trip_stopped template/);
  });
});

describe('a driver\'s photo over WhatsApp', () => {
  test('is fetched with the connection\'s key, stored and filed on the trip with its caption', async () => {
    await loadSample(owner);
    const wa = await connectMeta();
    const photo = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108020000009077', 'hex');
    const calls = recordMeta((c) => (c.url.includes('/media-77') ? { body: { url: 'https://lookaside.fbsbx.example/photo', mime_type: 'image/png' } } : c.url.startsWith('https://lookaside') ? { raw: photo, headers: { 'content-type': 'image/png' } } : { body: {} }));
    const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: '260971234567', id: 'wamid.P1', timestamp: '1793900000', type: 'image', image: { id: 'media-77', mime_type: 'image/png', caption: 'Toll at Tunduma' } }] } }] }] });
    const signature = `sha256=${createHmac('sha256', SECRETS.CONNECTION_WA_APP_SECRET).update(body).digest('hex')}`;
    await api().post(`/api/v1/hooks/${wa.id}`).set('content-type', 'application/json').set('x-hub-signature-256', signature).send(body).expect(200);
    assert.deepEqual(calls.slice(0, 2).map((c) => c.url), ['https://graph.facebook.com/v21.0/media-77', 'https://lookaside.fbsbx.example/photo'], 'the photo first, then the reply to the driver');
    const doc = await DriverDocument.findOne({ note: 'Toll at Tunduma' }).lean<{ file?: { fileId?: unknown; mime?: string } }>();
    assert.ok(doc?.file?.fileId, 'the photo is stored with the document');
    assert.equal(doc!.file!.mime, 'image/png');
    assert.ok(await WaContact.exists({ phone: '260971234567' }), 'the reply opened the 24 hours');
  });
});
