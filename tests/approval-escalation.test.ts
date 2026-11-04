// #53: a level that doesn't decide in time loses the request to the next one; SMS and e-mail reach approvers.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { env } from '../src/config/env.js';
import { setSmtpTransportFactory } from '../src/core/mail/mailer.js';
import { registerSmsAdapter } from '../src/core/sms/index.js';
import { settleSends } from '../src/modules/messaging/dispatcher.js';
import { OutboundMessage } from '../src/modules/messaging/models/connection.model.js';
import { escalateDue } from '../src/modules/operations/escalation.js';
import { FundRequest } from '../src/modules/operations/models/funding.model.js';
import { User } from '../src/modules/users/user.model.js';
import { api, bearer, find, loadSample, resetDatabase, signUp, startDatabase, stopDatabase, userWithRole, type Session } from './helpers.js';

let owner: Session, ops: Session, fin: Session;
const ids: Record<string, string> = {};

const as = (s: Session) => ({
  get: (path: string, query: Record<string, unknown> = {}) => api().get(`/api/v1${path}`).query(query).set(bearer(s)),
  post: (path: string, body: unknown = {}) => api().post(`/api/v1${path}`).set(bearer(s)).send(body as object),
  patch: (path: string, body: unknown) => api().patch(`/api/v1${path}`).set(bearer(s)).send(body as object),
  put: (path: string, body: unknown) => api().put(`/api/v1${path}`).set(bearer(s)).send(body as object),
});
const ok = <T = any>(res: { status: number; body: any }, status = 200): T => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body.data as T;
};
const hoursFromNow = (n: number) => new Date(Date.now() + n * 3_600_000);

/** Changes a level of one of the sample's approval policies. */
async function setLevel(code: string, level: number, change: Record<string, unknown>) {
  const policy = await find(owner, 'approval-policies', code);
  const levels = policy.levels.map((l: { level: number }) => (l.level === level ? { ...l, ...change } : l));
  ok(await as(owner).patch(`/approval-policies/${policy.id}`, { version: policy.version, levels }));
}

async function newTrip() {
  ok(await as(ops).put(`/vehicle-states/${ids.v1}`, { placeId: ids.depot, fuelL: 200 }));
  return ok(await as(ops).post('/trips', {
    customerId: ids.zambezi, vehicleId: ids.v1, driverId: ids.d1, trailerId: ids.t1, routeId: ids.routeDar, plannedStart: '2026-11-03T06:00:00.000Z', productId: ids.diesel,
  }), 201);
}
/** 600 litres: under the owner's level, so the amount alone only needs Finance. */
const fuelRequest = (trip: { id: string }) => as(ops).post('/fund-requests', { tripId: trip.id, kind: 'fuel', litres: 600 });
const inThread = async (thread: string, refId: string) => ok<any[]>(await as(owner).get('/messages', { thread, limit: 100 })).filter((m) => m.refId === refId);

before(startDatabase);
after(stopDatabase);
beforeEach(async () => {
  await resetDatabase();
  owner = await signUp('Olga Owner');
  await loadSample(owner);
  ops = await userWithRole(owner, 'operations', 'Olivia Ops');
  fin = await userWithRole(owner, 'finance', 'Felix Finance');
  const lookups: Array<[string, string, string]> = [
    ['zambezi', 'parties', 'Zambezi'], ['v1', 'vehicles', 'ALC 4821'], ['t1', 'trailers', 'TAC 7821'], ['d1', 'drivers', 'Joseph'], ['routeDar', 'routes', 'DAR-LSK'],
    ['depot', 'places', 'LSK-DEPOT'], ['diesel', 'products', 'DIESEL-50'], ['ZMW', 'currencies', 'ZMW'], ['ecRoad', 'expense-categories', 'ROAD'],
  ];
  for (const [key, master, search] of lookups) ids[key] = (await find(owner, master, search)).id;
  ids.finance = (await find(owner, 'roles', 'finance')).id;
  ids.owner = (await find(owner, 'roles', 'owner')).id;
});

describe('escalation', () => {
  test('after its hours a request moves to the next level up: recorded, told, and the old level can no longer decide', async () => {
    await setLevel('FUEL-L', 1, { escalateAfterHours: 24 });
    const trip = await newTrip();
    const raised = ok(await fuelRequest(trip), 201);
    assert.equal(raised.approval.levels.length, 1, 'the amount only needs Finance');

    assert.equal(await escalateDue(hoursFromNow(23)), 0, 'not yet');
    assert.equal(await escalateDue(hoursFromNow(25)), 1);

    const moved = ok(await as(owner).get(`/fund-requests/${raised.id}`));
    assert.equal(moved.status, 'pending');
    assert.equal(moved.approval.current, 1);
    assert.deepEqual(moved.approval.levels.map((l: { thread: string }) => l.thread), ['role:finance', 'role:owner'], 'the next level comes from the policy');
    assert.ok(moved.approval.levels[0].escalatedAt);
    assert.equal(moved.approval.levels[0].decidedBy, undefined, 'moving on is not an approval');
    assert.equal(moved.approval.escalateAt, undefined, 'the owner has no time limit');
    const entry = moved.trail.at(-1);
    assert.equal(entry.what, 'escalated');
    assert.match(entry.note, /did not decide within 24 hours/);

    const told = await inThread('role:owner', raised.id);
    assert.equal(told.length, 1);
    assert.match(told[0].text, /did not decide within 24 hours/);
    assert.ok(told[0].buttons.length, 'with buttons to answer');
    const [earlier] = await inThread('role:finance', raised.id);
    assert.match(earlier.resolved, /^Moved to /, 'the old buttons are done');

    const entries = ok<any[]>(await as(owner).get('/audit-logs', { entity: 'trips', entityId: trip.id, limit: 50 }));
    const logged = entries.find((e) => /moved from .* to .*no decision within 24 hours/.test(e.summary ?? ''));
    assert.ok(logged, JSON.stringify(entries.map((e) => e.summary)));
    assert.equal(logged.actorName, null, 'nobody did it: the screen shows System');

    await as(fin).post(`/fund-requests/${raised.id}/decide`, { approve: true }).expect(403);
    assert.equal(ok(await as(owner).post(`/fund-requests/${raised.id}/decide`, { approve: true })).status, 'approved');
    assert.equal(await escalateDue(hoursFromNow(1000)), 0);
  });

  test('a level gets its full time from when it starts waiting, and the top level stays put', async () => {
    await setLevel('ADV-ZMW', 1, { escalateAfterHours: 24 }); // level 2, the owner, has 4 hours in the sample
    const trip = await newTrip();
    const f = ok(await as(ops).get(`/trips/${trip.id}/funding`));
    const raised = ok(await as(ops).post('/fund-requests', { tripId: trip.id, kind: 'cash', amount: { amountMinor: f.cash.suggestedMinor + 1000_00, currencyId: ids.ZMW }, reason: 'Border fees' }), 201);
    assert.equal(raised.approval.levels.length, 2, 'above budget both levels approve');

    const approved = ok(await as(fin).post(`/fund-requests/${raised.id}/decide`, { approve: true }));
    assert.equal(approved.approval.current, 1);
    assert.equal(await escalateDue(hoursFromNow(3)), 0, 'the owner has 4 hours from the approval');

    const before = (await inThread('role:owner', raised.id)).length;
    assert.equal(await escalateDue(hoursFromNow(5)), 0, 'nobody above the owner');
    assert.equal((await inThread('role:owner', raised.id)).length, before, 'and no second message');
    const still = ok(await as(owner).get(`/fund-requests/${raised.id}`));
    assert.equal(still.approval.current, 1);
    assert.equal(still.approval.escalateAt, undefined, 'the job stops looking at it');
  });

  test('the next level gets its own time after a move', async () => {
    await setLevel('ADV-ZMW', 1, { escalateAfterHours: 24 });
    const trip = await newTrip();
    const f = ok(await as(ops).get(`/trips/${trip.id}/funding`));
    const raised = ok(await as(ops).post('/fund-requests', { tripId: trip.id, kind: 'cash', amount: { amountMinor: f.cash.suggestedMinor + 1000_00, currencyId: ids.ZMW }, reason: 'Border fees' }), 201);
    const at = hoursFromNow(25);
    assert.equal(await escalateDue(at), 1);
    const moved = ok(await as(owner).get(`/fund-requests/${raised.id}`));
    assert.equal(moved.approval.current, 1);
    assert.equal(moved.approval.escalateAt, new Date(at.getTime() + 4 * 3_600_000).toISOString());
  });

  test('a decided request never moves, and without hours nothing does', async () => {
    const trip = await newTrip();
    const untimed = ok(await fuelRequest(trip), 201);
    assert.equal(untimed.approval.escalateAt, undefined);
    assert.equal(await escalateDue(hoursFromNow(1000)), 0);
    ok(await as(fin).post(`/fund-requests/${untimed.id}/decide`, { approve: false, note: 'Too much' }));

    await setLevel('FUEL-L', 1, { escalateAfterHours: 24 });
    const rejected = ok(await fuelRequest(trip), 201);
    ok(await as(fin).post(`/fund-requests/${rejected.id}/decide`, { approve: false, note: 'Too much' }));
    assert.equal(await escalateDue(hoursFromNow(25)), 0);
    const approved = ok(await fuelRequest(trip), 201);
    ok(await as(fin).post(`/fund-requests/${approved.id}/decide`, { approve: true }));
    assert.equal(await escalateDue(hoursFromNow(25)), 0);
  });

  test('two runs at once move a request once', async () => {
    await setLevel('FUEL-L', 1, { escalateAfterHours: 24 });
    const raised = ok(await fuelRequest(await newTrip()), 201);
    const at = hoursFromNow(25);
    const counts = await Promise.all([escalateDue(at), escalateDue(at), escalateDue(at)]);
    assert.equal(counts.reduce((a, b) => a + b), 1);
    assert.equal((await inThread('role:owner', raised.id)).length, 1);
    const moved = ok(await as(owner).get(`/fund-requests/${raised.id}`));
    assert.equal(moved.trail.filter((t: { what: string }) => t.what === 'escalated').length, 1);
    assert.equal(moved.approval.levels.length, 2);
  });

  test('a decision being saved as the request moves is refused, so the two cannot both stand', async () => {
    await setLevel('FUEL-L', 1, { escalateAfterHours: 24 });
    const raised = ok(await fuelRequest(await newTrip()), 201);
    const loadedForDecision = await FundRequest.findById(raised.id);
    assert.equal(await escalateDue(hoursFromNow(25)), 1);
    loadedForDecision!.set('status', 'approved');
    await assert.rejects(loadedForDecision!.save(), { name: 'VersionError' });
  });

  test('an expense moves up the same way', async () => {
    ok(await as(owner).post('/approval-policies', {
      code: 'EXP', name: 'Expenses', subject: 'expense', currencyId: ids.ZMW,
      levels: [{ level: 1, minAmountMinor: 0, approverRoleId: ids.finance, escalateAfterHours: 8 }, { level: 2, minAmountMinor: 1_000_000_00, approverRoleId: ids.owner }],
    }), 201);
    const trip = await newTrip();
    const expense = ok(await as(ops).post('/expenses', { driverId: ids.d1, tripId: trip.id, categoryId: ids.ecRoad, amount: { amountMinor: 250_00, currencyId: ids.ZMW }, receiptNo: 'R-1' }), 201);
    assert.equal(expense.status, 'pending');
    assert.equal(await escalateDue(hoursFromNow(9)), 1);
    const moved = ok(await as(owner).get(`/expenses/${expense.id}`));
    assert.equal(moved.approval.current, 1);
    const [told] = await inThread('role:owner', expense.id);
    assert.match(told.text, /did not decide within 8 hours/);
    assert.ok(told.rows.some(([name]: [string]) => name === 'Amount'));
    const entries = ok<any[]>(await as(owner).get('/audit-logs', { entity: 'expenses', entityId: expense.id }));
    assert.ok(entries.some((e) => /moved from/.test(e.summary ?? '') && e.title === expense.number));
    await as(fin).post(`/expenses/${expense.id}/decide`, { approve: true }).expect(403);
    assert.equal(ok(await as(owner).post(`/expenses/${expense.id}/decide`, { approve: true })).status, 'approved');
  });
});

describe('approval channels', () => {
  const smtp: Array<{ to: string; subject: string; text: string }> = [];
  const sms: Array<{ to: string; text: string }> = [];
  registerSmsAdapter({ key: 'approval-sms', label: 'Test provider', simulated: false, async send(m) { sms.push(m); return { providerRef: `s-${sms.length}`, simulated: false }; } });

  beforeEach(() => {
    smtp.length = 0;
    sms.length = 0;
    env.DRIVER_PHONE_SIMULATOR = false;
    setSmtpTransportFactory(() => ({ sendMail: (async (m: (typeof smtp)[number]) => { smtp.push(m); return { messageId: '<1@fake>' }; }) as never }));
  });

  test('SMS and e-mail go to the level\'s people through the connections, and show in the outbox', async () => {
    ok(await as(owner).post('/message-connections', { code: 'SMTP', name: 'Company SMTP', channel: 'email', provider: 'smtp', enabled: true, host: 'smtp.example.com', from: 'Fleet <fleet@example.com>' }), 201);
    process.env.MESSAGING_APPROVAL_SMS_KEY = 'key';
    ok(await as(owner).post('/message-connections', { code: 'SMS', name: 'SMS', channel: 'sms', provider: 'approval-sms', enabled: true, user: 'marichi', senderId: 'MARICHI', secretEnv: 'MESSAGING_APPROVAL_SMS_KEY' }), 201);
    await setLevel('FUEL-L', 1, { channels: ['app', 'sms', 'email'] });
    await User.updateOne({ _id: fin.userId }, { $set: { phone: '+260971000001' } });
    const other = await userWithRole(owner, 'finance', 'Faith Finance');

    const raised = ok(await fuelRequest(await newTrip()), 201);
    await settleSends();

    const out = await OutboundMessage.find({ event: 'approval.waiting' }).lean();
    const of = (name: string, channel: string) => out.find((m) => m.toName === name && m.channel === channel)!;
    assert.equal(of('Felix Finance', 'sms').status, 'sent');
    assert.equal(of('Felix Finance', 'sms').to, '+260971000001');
    assert.equal(of('Felix Finance', 'email').status, 'sent');
    assert.equal(of('Felix Finance', 'email').to, fin.email);
    assert.deepEqual(of('Felix Finance', 'sms').ref, { kind: 'fund-requests', id: raised.id });
    assert.equal(of('Faith Finance', 'email').to, other.email);
    assert.equal(of('Faith Finance', 'sms').status, 'skipped', 'no phone: the outbox says so');
    assert.match(of('Faith Finance', 'sms').note!, /has no phone number/);

    assert.equal(sms.length, 1);
    assert.equal(sms[0]!.to, '+260971000001');
    assert.equal(sms[0]!.text, `Fuel request ${raised.number}. Within the trip budget. Amount: 600 L. Open the app to decide: ${env.APP_URL}`);
    const mail = smtp.find((m) => m.to === fin.email)!;
    assert.match(mail.subject, new RegExp(raised.number));
    assert.match(mail.text, /Amount: 600 L/);
    assert.ok(mail.text.includes(env.APP_URL));
    assert.equal((await inThread('role:finance', raised.id)).length, 1, 'still in the app too');
  });

  test('a level on the app alone sends nothing outside it, and an escalated level uses its own channels', async () => {
    await setLevel('FUEL-L', 1, { channels: ['app'], escalateAfterHours: 24 });
    await setLevel('FUEL-L', 2, { channels: ['app', 'email'] });
    ok(await fuelRequest(await newTrip()), 201);
    await settleSends();
    assert.equal(await OutboundMessage.countDocuments({ event: 'approval.waiting' }), 0);

    assert.equal(await escalateDue(hoursFromNow(25)), 1);
    await settleSends();
    const out = await OutboundMessage.find({ event: 'approval.waiting' }).lean();
    assert.deepEqual(out.map((m) => [m.toName, m.channel]), [['Olga Owner', 'email']]);
    assert.match(out[0]!.body, /did not decide within 24 hours/);
  });
});
