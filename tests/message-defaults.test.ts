// #43: a new installation starts with a template and a rule for each event the steps send, created once.
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { after, before, beforeEach, describe, test } from 'node:test';
import { setFileStore } from '../src/core/storage/index.js';
import { DEFAULT_RULES, DEFAULT_TEMPLATES, ensureDefaultMessages } from '../src/modules/messaging/defaults.js';
import { settleSends } from '../src/modules/messaging/dispatcher.js';
import { OutboundMessage } from '../src/modules/messaging/models/connection.model.js';
import { MessageTemplate, NotificationRule } from '../src/modules/messaging/models/messaging.model.js';
import { placeholders } from '../src/modules/messaging/messaging.service.js';
import { api, bearer, find, loadSample, resetDatabase, signUp, startDatabase, stopDatabase, userWithRole, type Session } from './helpers.js';

/** The events the trip and money steps send (#29). */
const STEP_EVENTS = [
  'trip.dispatched', 'trip.arrived_loading', 'trip.arrived_offloading', 'trip.loaded', 'trip.delivered', 'trip.closed',
  'fund_request.created', 'fund_request.approved', 'fund_request.rejected', 'fund_request.paid',
  'expense.submitted', 'expense.approved', 'expense.rejected', 'settlement.posted', 'nomination.sent',
];

let owner: Session;
const as = (s: Session) => ({
  get: (path: string, query: Record<string, unknown> = {}) => api().get(`/api/v1${path}`).query(query).set(bearer(s)),
  post: (path: string, body: unknown = {}) => api().post(`/api/v1${path}`).set(bearer(s)).send(body as object),
  patch: (path: string, body: unknown) => api().patch(`/api/v1${path}`).set(bearer(s)).send(body as object),
  put: (path: string, body: unknown) => api().put(`/api/v1${path}`).set(bearer(s)).send(body as object),
  delete: (path: string) => api().delete(`/api/v1${path}`).set(bearer(s)),
});
const ok = <T = any>(res: { status: number; body: any }, status = 200): T => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body.data as T;
};

const files = new Map<string, Buffer>();
before(async () => {
  await startDatabase();
  setFileStore({ async put(key, body) { files.set(key, body); }, async open(key) { return Readable.from([files.get(key)!]); }, async remove(key) { files.delete(key); } });
});
after(stopDatabase);
beforeEach(async () => {
  await resetDatabase();
  owner = await signUp('Owner');
});

describe('the default set', () => {
  test('covers every event the steps send, in plain words with values the steps fill in', () => {
    for (const event of STEP_EVENTS) {
      const rules = DEFAULT_RULES.filter((r) => r.event === event);
      assert.ok(rules.length, `no default rule for ${event}`);
      for (const r of rules) for (const t of r.templates) if (t.template) assert.equal(DEFAULT_TEMPLATES.find((x) => x.code === t.template)?.event, event, `${r.code} → ${t.template}`);
    }
    for (const t of DEFAULT_TEMPLATES) {
      assert.deepEqual([...placeholders(t.body).problems, ...placeholders(t.subject ?? '').problems], [], t.code);
      assert.doesNotMatch(t.body, /[A-Z]{3,}_[A-Z]+/, `${t.code} names a setting`);
    }
    // The customer hears about its cargo, never the trip's money or the trip sheet.
    const customerEvents = DEFAULT_RULES.filter((r) => r.recipients.some((x) => x.kind === 'party_contact')).map((r) => r.event);
    assert.ok(customerEvents.every((e) => e.startsWith('trip.') || e === 'nomination.sent') && !customerEvents.includes('trip.closed'), customerEvents.join(', '));
  });
});

describe('created once, at start-up', () => {
  test('a fresh installation gets them all, marked as defaults; a second start-up creates nothing', async () => {
    const first = await ensureDefaultMessages();
    assert.equal(first.created, DEFAULT_TEMPLATES.length + DEFAULT_RULES.length);
    assert.equal(await MessageTemplate.countDocuments({ isDefault: true, status: 'active' }), DEFAULT_TEMPLATES.length);
    assert.equal(await NotificationRule.countDocuments({ isDefault: true, status: 'active' }), DEFAULT_RULES.length);
    const finance = await NotificationRule.findOne({ code: 'ADV-REQUEST' }).lean();
    assert.equal(finance!.recipients[0]!.kind, 'role');
    assert.equal(String(finance!.recipients[0]!.roleId), (await find(owner, 'roles', 'finance')).id);
    // Like any record: on the API, with a history.
    const listed = ok(await as(owner).get('/notification-rules', { limit: 100 }));
    assert.equal(listed.length, DEFAULT_RULES.length);
    assert.equal((await ensureDefaultMessages()).created, 0);
  });

  test('edits, archives and deletions survive a restart', async () => {
    await ensureDefaultMessages();
    const template = await find(owner, 'message-templates', 'EM-TRIP-DISPATCHED');
    ok(await as(owner).patch(`/message-templates/${template.id}`, { version: template.version, body: 'Our own words for {{trip.number}}.' }));
    const archived = await find(owner, 'notification-rules', 'TRIP-LOADED-DRIVER');
    ok(await as(owner).post(`/notification-rules/${archived.id}/archive`, { reason: 'We phone the driver' }));
    const removed = await find(owner, 'notification-rules', 'FUND-PAID-OPS');
    assert.equal((await as(owner).delete(`/notification-rules/${removed.id}`)).status, 204);

    assert.equal((await ensureDefaultMessages()).created, 0, 'a restart');
    assert.equal((await MessageTemplate.findOne({ code: 'EM-TRIP-DISPATCHED' }).lean())!.body, 'Our own words for {{trip.number}}.');
    assert.equal((await NotificationRule.findOne({ code: 'TRIP-LOADED-DRIVER' }).lean())!.status, 'archived');
    assert.equal(await NotificationRule.exists({ code: 'FUND-PAID-OPS' }), null, 'what the company deleted stays deleted');
  });

  test('an installation that already has its own messages is left alone', async () => {
    ok(await as(owner).post('/message-templates', { code: 'OUR-SMS', name: 'Ours', channel: 'sms', event: 'trip.dispatched', body: 'Off you go, {{driver.name}}.' }), 201);
    assert.equal((await ensureDefaultMessages()).created, 0);
    assert.equal(await MessageTemplate.countDocuments({}), 1);
    assert.equal(await NotificationRule.countDocuments({}), 0);
  });

  test('a start-up that stopped half-way is finished by the next one', async () => {
    await ensureDefaultMessages();
    await NotificationRule.deleteMany({ code: { $in: ['SETTLEMENT-DRIVER', 'NOMINATION-CUSTOMER'] } });
    const marks = (await import('mongoose')).default.connection.db!.collection('message_defaults');
    await marks.updateOne({ _id: 'messages' as never }, { $set: { state: 'creating' } });
    assert.equal((await ensureDefaultMessages()).created, 2);
    assert.equal(await NotificationRule.countDocuments({ isDefault: true }), DEFAULT_RULES.length);
  });
});

describe('the sample data uses the same set', () => {
  test('a fuel trip from funding to settlement puts the expected messages in the outbox', async () => {
    await loadSample(owner);
    assert.equal(await MessageTemplate.countDocuments({ isDefault: true }), DEFAULT_TEMPLATES.length, 'the sample brings no templates of its own');
    const ops = await userWithRole(owner, 'operations', 'Olivia Ops');
    const fin = await userWithRole(owner, 'finance', 'Felix Finance');
    const ids: Record<string, string> = {};
    for (const [key, master, search] of [
      ['zambezi', 'parties', 'Zambezi'], ['v1', 'vehicles', 'ALC 4821'], ['t1', 'trailers', 'TAC 7821'], ['d1', 'drivers', 'Joseph'], ['routeDar', 'routes', 'DAR-LSK'],
      ['depot', 'places', 'LSK-DEPOT'], ['diesel', 'products', 'DIESEL-50'], ['ZMW', 'currencies', 'ZMW'], ['pmCash', 'payment-methods', 'CASH'], ['pmDepot', 'payment-methods', 'DEPOT'],
    ] as const) ids[key] = (await find(owner, master, search)).id;

    ok(await as(ops).put(`/vehicle-states/${ids.v1}`, { placeId: ids.depot, fuelL: 200 }));
    const trip = ok(await as(ops).post('/trips', { customerId: ids.zambezi, vehicleId: ids.v1, driverId: ids.d1, trailerId: ids.t1, routeId: ids.routeDar, plannedStart: '2026-11-03T06:00:00.000Z', productId: ids.diesel }), 201);
    const f = ok(await as(ops).get(`/trips/${trip.id}/funding`));
    const cash = ok(await as(ops).post('/fund-requests', { tripId: trip.id, kind: 'cash', amount: { amountMinor: f.cash.suggestedMinor, currencyId: ids.ZMW } }), 201);
    const fuel = ok(await as(ops).post('/fund-requests', { tripId: trip.id, kind: 'fuel', litres: f.fuel.suggested }), 201);
    for (const r of [cash, fuel]) ok(await as(fin).post(`/fund-requests/${r.id}/decide`, { approve: true }));
    ok(await as(fin).post(`/fund-requests/${fuel.id}/issue`, { paymentMethodId: ids.pmDepot, reference: 'DP-1' }));
    ok(await as(fin).post(`/fund-requests/${cash.id}/issue`, { paymentMethodId: ids.pmCash }));
    ok(await as(ops).post(`/trips/${trip.id}/dispatch`));
    const load = ok(await as(ops).post('/consignments', { tripId: trip.id, productId: ids.diesel, invoiceNo: 'INV-9', qty: 38000, ambientL: 38000, tempC: 20, density: 835 }), 201);
    ok(await as(ops).post(`/trips/${trip.id}/position`, { km: 99_999, speed: 70, source: 'gps' }));
    ok(await as(ops).post(`/consignments/${load.id}/delivery`, { podNo: 'POD-9', qty: 38000, ambientL: 38000, tempC: 20, density: 835, certStd20L: load.load.std20L }));
    ok(await as(ops).post(`/trips/${trip.id}/end`, { closingFuelL: 120 }));
    const balance = ok(await as(fin).get(`/driver-accounts/${ids.d1}`)).balanceMinor;
    const settlement = ok(await as(fin).post('/settlements', { driverId: ids.d1, tripIds: [trip.id], cashMinor: balance }), 201);
    await settleSends();

    const outbox = await OutboundMessage.find({}).lean();
    const one = (event: string, channel: string, toName: string) => {
      const found = outbox.filter((m) => m.event === event && m.channel === channel && m.toName === toName);
      assert.equal(found.length, event.startsWith('fund_request.') ? 2 : 1, `${event} ${channel} to ${toName}: ${found.length}`);
      return found[0]!;
    };
    assert.match(one('trip.dispatched', 'sms', 'Joseph Mwansa').body, new RegExp(`^${trip.number}: you are dispatched with ALC 4821 on \\S.* to \\S.*\\. Safe travels\\.$`));
    assert.match(one('trip.dispatched', 'email', 'Zambezi Energy Ltd').subject!, new RegExp(`^${trip.number}: truck ALC 4821 is on its way$`));
    assert.match(one('trip.arrived_loading', 'email', 'Olivia Ops').body, /reached .* for loading/);
    assert.match(one('trip.loaded', 'email', 'Zambezi Energy Ltd').body, /invoice INV-9/);
    assert.match(one('trip.delivered', 'sms', 'Joseph Mwansa').body, /note POD-9/);
    assert.match(one('fund_request.created', 'email', 'Felix Finance').subject!, / requested$/);
    one('fund_request.created', 'whatsapp', 'Felix Finance');
    one('fund_request.approved', 'email', 'Olivia Ops');
    one('fund_request.paid', 'sms', 'Joseph Mwansa');
    const sheet = one('trip.closed', 'email', 'Felix Finance');
    assert.equal(sheet.subject, `Trip sheet ${trip.number}`);
    assert.equal(sheet.attachments?.[0]?.name, `Trip sheet ${trip.number.replace(/\//g, '-')}.pdf`);
    one('trip.closed', 'email', 'Olivia Ops');
    assert.match(one('settlement.posted', 'sms', 'Joseph Mwansa').body, new RegExp(`Settlement ${settlement.number} for ${trip.number} is posted`));
    assert.equal(one('settlement.posted', 'email', 'Joseph Mwansa').status, 'skipped', 'the driver has no e-mail address');
    assert.equal(outbox.some((m) => m.toName === 'Zambezi Energy Ltd' && ['trip.closed', 'settlement.posted', 'fund_request.created'].includes(m.event)), false, 'the customer never hears about money');
    // Every message rendered: no placeholder left over.
    for (const m of outbox) assert.doesNotMatch(`${m.subject ?? ''} ${m.body}`, /\{\{/, m.event);
  });
});
