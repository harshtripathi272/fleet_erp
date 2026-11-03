// #29: trip and money steps send their messages through the dispatcher, on the channels the company chose.
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { Readable } from 'node:stream';
import { setSmtpTransportFactory } from '../src/core/mail/mailer.js';
import { setFileStore } from '../src/core/storage/index.js';
import { processDue, settleSends } from '../src/modules/messaging/dispatcher.js';
import { OutboundMessage } from '../src/modules/messaging/models/connection.model.js';
import { MessageTemplate, NotificationRule } from '../src/modules/messaging/models/messaging.model.js';
import { renderPdf } from '../src/modules/operations/pdf.js';
import { api, bearer, find, loadSample, resetDatabase, signUp, startDatabase, stopDatabase, userWithRole, type Session } from './helpers.js';

const EVENTS = [
  'trip.dispatched', 'trip.arrived_loading', 'trip.loaded', 'trip.arrived_offloading', 'trip.delivered', 'trip.closed',
  'fund_request.created', 'fund_request.approved', 'fund_request.rejected', 'fund_request.paid',
  'expense.submitted', 'expense.approved', 'expense.rejected', 'settlement.posted', 'nomination.sent',
] as const;
/** Every template prints these, so a test can see which values a step passed. */
const BODY = 'trip={{trip.number}} truck={{vehicle.registration}} route={{route.name}} place={{place.name}} amount={{currency}} {{amount}} reason={{reason}} doc={{document.number}} driver={{driver.name}} customer={{customer.name}}';

/** A stand-in SMTP server; fails while `failures` > 0. */
const smtp = { sent: [] as Array<{ to: string; subject: string; text: string; attachments?: Array<{ filename: string; content: Buffer }> }>, failures: 0 };

let owner: Session, ops: Session, fin: Session;
const ids: Record<string, string> = {};

const as = (s: Session) => ({
  get: (path: string, query: Record<string, unknown> = {}) => api().get(`/api/v1${path}`).query(query).set(bearer(s)),
  post: (path: string, body: unknown = {}) => api().post(`/api/v1${path}`).set(bearer(s)).send(body as object),
  put: (path: string, body: unknown) => api().put(`/api/v1${path}`).set(bearer(s)).send(body as object),
});
const ok = <T = any>(res: { status: number; body: any }, status = 200): T => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body.data as T;
};

/** For every event: an e-mail and an SMS, to the driver, Finance and the customer's contact. */
async function rulesForEveryEvent() {
  const finance = await find(owner, 'roles', 'finance');
  ok(await as(owner).post('/message-connections', { code: 'SMTP', name: 'Company SMTP', channel: 'email', provider: 'smtp', enabled: true, host: 'smtp.example.com', from: 'Fleet <fleet@example.com>' }), 201);
  for (const [i, event] of EVENTS.entries()) {
    const email = ok(await as(owner).post('/message-templates', { code: `T-EM-${i}`, name: `${event} e-mail`, channel: 'email', event, subject: `[${event}] {{trip.number}}`, body: BODY }), 201);
    const sms = ok(await as(owner).post('/message-templates', { code: `T-SMS-${i}`, name: `${event} SMS`, channel: 'sms', event, body: BODY }), 201);
    ok(await as(owner).post('/notification-rules', {
      code: `R-${i}`, name: event, event,
      recipients: [{ kind: 'driver' }, { kind: 'role', roleId: finance.id }, { kind: 'party_contact' }],
      templates: [{ channel: 'email', templateId: email.id }, { channel: 'sms', templateId: sms.id }],
    }), 201);
  }
}

async function newTrip() {
  ok(await as(ops).put(`/vehicle-states/${ids.v1}`, { placeId: ids.depot, fuelL: 200 }));
  return ok(await as(ops).post('/trips', {
    customerId: ids.zambezi, vehicleId: ids.v1, driverId: ids.d1, trailerId: ids.t1, routeId: ids.routeDar,
    plannedStart: '2026-11-03T06:00:00.000Z', productId: ids.diesel,
  }), 201);
}

async function fundAndDispatch(trip: { id: string }) {
  const f = ok(await as(ops).get(`/trips/${trip.id}/funding`));
  const fuel = ok(await as(ops).post('/fund-requests', { tripId: trip.id, kind: 'fuel', litres: f.fuel.suggested }), 201);
  const cash = ok(await as(ops).post('/fund-requests', { tripId: trip.id, kind: 'cash', amount: { amountMinor: f.cash.suggestedMinor, currencyId: ids.ZMW } }), 201);
  ok(await as(fin).post(`/fund-requests/${fuel.id}/decide`, { approve: true }));
  ok(await as(fin).post(`/fund-requests/${cash.id}/decide`, { approve: true }));
  ok(await as(fin).post(`/fund-requests/${fuel.id}/issue`, { paymentMethodId: ids.pmDepot, reference: 'DP-1' }));
  ok(await as(fin).post(`/fund-requests/${cash.id}/issue`, { paymentMethodId: ids.pmCash }));
  ok(await as(ops).post(`/trips/${trip.id}/dispatch`));
  return { cash };
}

/** What went out for an event, once the sends a step started have finished. */
async function sent(event: string) {
  await settleSends();
  return OutboundMessage.find({ event }).sort({ at: 1 }).lean();
}

/** Printouts are kept in memory, not on disk. */
const files = new Map<string, Buffer>();
before(async () => {
  await startDatabase();
  setFileStore({
    async put(key, body) { files.set(key, body); },
    async open(key) { return Readable.from([files.get(key)!]); },
    async remove(key) { files.delete(key); },
  });
});
after(stopDatabase);
beforeEach(async () => {
  await resetDatabase();
  smtp.sent.length = 0; smtp.failures = 0;
  setSmtpTransportFactory(() => ({
    sendMail: (async (m: (typeof smtp.sent)[number]) => {
      if (smtp.failures > 0) { smtp.failures -= 1; throw new Error('421 Try again later'); }
      smtp.sent.push(m);
      return { messageId: `<${smtp.sent.length}@fake>` };
    }) as never,
  }));
  owner = await signUp('Owner');
  await loadSample(owner);
  ops = await userWithRole(owner, 'operations', 'Olivia Ops');
  fin = await userWithRole(owner, 'finance', 'Felix Finance');
  const lookups: Array<[string, string, string]> = [
    ['zambezi', 'parties', 'Zambezi'], ['copper', 'parties', 'Copperbelt'], ['v1', 'vehicles', 'ALC 4821'], ['v2', 'vehicles', 'BCA 9034'], ['t1', 'trailers', 'TAC 7821'],
    ['d1', 'drivers', 'Joseph'], ['routeDar', 'routes', 'DAR-LSK'], ['depot', 'places', 'LSK-DEPOT'], ['darPort', 'places', 'DAR-PORT'],
    ['diesel', 'products', 'DIESEL-50'], ['ZMW', 'currencies', 'ZMW'], ['pmCash', 'payment-methods', 'CASH'], ['pmDepot', 'payment-methods', 'DEPOT'], ['ecRoad', 'expense-categories', 'ROAD'],
  ];
  for (const [key, master, search] of lookups) ids[key] = (await find(owner, master, search)).id;
  // Only this file's rules: the installation's defaults (#43) are tested in message-defaults.test.ts.
  await NotificationRule.deleteMany({ isDefault: true });
  await rulesForEveryEvent();
});
afterEach(() => setSmtpTransportFactory(null));

describe('each step sends its messages once, through the dispatcher', () => {
  test('a fuel trip from funding to settlement', async () => {
    const trip = await newTrip();
    const { cash } = await fundAndDispatch(trip);

    ok(await as(ops).post(`/trips/${trip.id}/position`, { km: 2500, speed: 70, source: 'gps' }));
    ok(await as(ops).post(`/trips/${trip.id}/position`, { km: 2500, speed: 70, source: 'gps' }));
    const load = ok(await as(ops).post('/consignments', { tripId: trip.id, productId: ids.diesel, invoiceNo: 'INV-1', qty: 38000, ambientL: 38000, tempC: 20, density: 835 }), 201);
    ok(await as(ops).post(`/trips/${trip.id}/position`, { km: 9999, speed: 70, source: 'gps' }));
    ok(await as(ops).post(`/consignments/${load.id}/delivery`, { podNo: 'POD-1', qty: 38000, ambientL: 38000, tempC: 20, density: 835, certStd20L: load.load.std20L }));
    ok(await as(fin).post('/expenses', { driverId: ids.d1, tripId: trip.id, categoryId: ids.ecRoad, amount: { amountMinor: 250_00, currencyId: ids.ZMW }, receiptNo: 'R-77' }), 201);
    ok(await as(ops).post(`/trips/${trip.id}/end`, { closingFuelL: 120 }));
    const balance = ok(await as(fin).get(`/driver-accounts/${ids.d1}`)).balanceMinor;
    const settlement = ok(await as(fin).post('/settlements', { driverId: ids.d1, tripIds: [trip.id], cashMinor: balance }), 201);

    // Once per step: two requests make two of each request event; everything else happened once.
    const times: Record<string, number> = { 'fund_request.created': 2, 'fund_request.approved': 2, 'fund_request.paid': 2 };
    for (const event of ['trip.dispatched', 'trip.arrived_loading', 'trip.loaded', 'trip.arrived_offloading', 'trip.delivered', 'trip.closed', 'fund_request.created', 'fund_request.approved', 'fund_request.paid', 'expense.approved', 'settlement.posted']) {
      const out = await sent(event);
      const toFinance = out.filter((m) => m.channel === 'email' && m.toName === 'Felix Finance');
      assert.equal(toFinance.length, times[event] ?? 1, `${event}: ${toFinance.length} e-mails to Finance`);
      const toDriver = out.filter((m) => m.channel === 'sms' && m.toName === 'Joseph Mwansa');
      assert.equal(toDriver.length, times[event] ?? 1, `${event}: ${toDriver.length} SMS to the driver`);
      assert.equal(toDriver[0]!.to, '+260971234567');
      assert.equal(toDriver[0]!.status, 'simulated', 'phones are simulated in tests');
    }
    assert.equal((await sent('expense.submitted')).length, 0, 'an expense Finance approves as it records it is not also "submitted"');

    // The right values for each step.
    const [dispatched] = (await sent('trip.dispatched')).filter((m) => m.channel === 'email');
    assert.match(dispatched!.body, new RegExp(`trip=${trip.number} truck=ALC 4821 route=\\S.* to \\S.* place=`));
    assert.match(dispatched!.body, /driver=Joseph Mwansa customer=Zambezi Energy Ltd/);
    assert.equal(dispatched!.subject, `[trip.dispatched] ${trip.number}`);
    assert.deepEqual(dispatched!.ref, { kind: 'trips', id: trip.id });
    const [loaded] = (await sent('trip.loaded')).filter((m) => m.channel === 'email');
    assert.match(loaded!.body, /doc=INV-1/);
    assert.equal(loaded!.ref?.kind, 'consignments');
    const [delivered] = (await sent('trip.delivered')).filter((m) => m.channel === 'email');
    assert.match(delivered!.body, /doc=POD-1/);
    const advance = (await sent('fund_request.created')).filter((m) => m.channel === 'email' && m.ref?.id === cash.id);
    assert.match(advance[0]!.body, /amount=ZMW \d{1,3}(,\d{3})*\.\d{2} /);
    const [fuelAsked] = (await sent('fund_request.created')).filter((m) => m.channel === 'email');
    assert.match(fuelAsked!.body, /amount= [\d,]+ L /, 'fuel is asked in litres');
    const [expense] = (await sent('expense.approved')).filter((m) => m.channel === 'email');
    assert.match(expense!.body, /amount=ZMW 250\.00 .*doc=R-77/);

    // The driver has no e-mail address: that is skipped and says so; the customer gets the trip's messages.
    const closed = await sent('trip.closed');
    assert.equal(closed.find((m) => m.channel === 'email' && m.toName === 'Joseph Mwansa')!.status, 'skipped');
    assert.ok(closed.some((m) => m.channel === 'email' && m.to === 'natasha.banda@zambezi.example'));

    // The trip sheet goes with the trip.closed e-mails, and the statement with settlement.posted.
    const sheetMail = smtp.sent.find((m) => m.subject === `[trip.closed] ${trip.number}` && m.to === fin.email);
    assert.ok(sheetMail, 'the trip.closed e-mail went to Finance');
    assert.equal(sheetMail.attachments?.length, 1);
    assert.equal(sheetMail.attachments![0]!.filename, `Trip sheet ${trip.number.replace(/\//g, '-')}.pdf`);
    assert.equal(sheetMail.attachments![0]!.content.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.match(sheetMail.attachments![0]!.content.toString('latin1'), /INV-1/);
    const statementMail = smtp.sent.find((m) => m.subject.startsWith('[settlement.posted]') && m.to === fin.email);
    assert.equal(statementMail?.attachments?.[0]?.filename, `Statement ${settlement.number.replace(/\//g, '-')}.pdf`);
    assert.match(statementMail!.attachments![0]!.content.toString('latin1'), /Carried forward/);
    assert.equal((await sent('trip.closed')).filter((m) => m.channel === 'sms').every((m) => !m.attachments?.length), true, 'SMS carries no file');

    // The driver chat is unchanged: it still has the in-app messages.
    const chat = ok(await as(ops).get('/messages', { thread: `driver:${ids.d1}` })).map((m: { title?: string }) => m.title ?? '');
    for (const title of ['On your way', 'Loading confirmed', 'Delivery confirmed', 'closed', 'Settlement']) assert.ok(chat.some((t: string) => t.includes(title)), `driver chat lost: ${title}`);
  });

  test('rejections, an expense waiting for approval, and a nomination to the customer', async () => {
    const trip = await newTrip();
    const request = ok(await as(ops).post('/fund-requests', { tripId: trip.id, kind: 'cash', amount: { amountMinor: 100_00, currencyId: ids.ZMW } }), 201);
    ok(await as(fin).post(`/fund-requests/${request.id}/decide`, { approve: false, note: 'Already paid in cash' }));
    const [rejected] = (await sent('fund_request.rejected')).filter((m) => m.channel === 'email' && m.toName === 'Felix Finance');
    assert.match(rejected!.body, /amount=ZMW 100\.00 reason=Already paid in cash/);

    const pending = ok(await as(ops).post('/expenses', { driverId: ids.d1, tripId: trip.id, categoryId: ids.ecRoad, amount: { amountMinor: 80_00, currencyId: ids.ZMW } }), 201);
    assert.equal(pending.status, 'pending');
    assert.equal((await sent('expense.submitted')).filter((m) => m.channel === 'email' && m.toName === 'Felix Finance').length, 1);
    ok(await as(fin).post(`/expenses/${pending.id}/decide`, { approve: false, reason: 'No receipt' }));
    const [expenseRejected] = (await sent('expense.rejected')).filter((m) => m.channel === 'sms' && m.toName === 'Joseph Mwansa');
    assert.match(expenseRejected!.body, /reason=No receipt/);

    const n = ok(await as(ops).post('/nominations', { customerId: ids.zambezi, loadingPlaceId: ids.darPort, requiredDate: '2026-11-20', trucks: [{ vehicleId: ids.v2 }] }), 201);
    ok(await as(ops).post(`/nominations/${n.id}/send`));
    const nomination = await sent('nomination.sent');
    const toCustomer = nomination.filter((m) => m.toName === 'Zambezi Energy Ltd');
    assert.deepEqual(toCustomer.map((m) => [m.channel, m.to]).sort(), [['email', 'natasha.banda@zambezi.example'], ['sms', '+260966112233']]);
    assert.match(toCustomer[0]!.body, new RegExp(`truck=BCA 9034 .*place=\\S.*doc=${n.number}.*customer=Zambezi Energy Ltd`));
    assert.equal(nomination.some((m) => m.toName === 'Joseph Mwansa'), false, 'a nomination names no driver');
  });
});

describe('a failed send never fails the step', () => {
  test('the step succeeds; the outbox keeps the error and retries', async () => {
    smtp.failures = 100;
    const trip = await newTrip();
    await fundAndDispatch(trip);
    assert.equal(ok(await as(ops).get(`/trips/${trip.id}`)).state, 'on_road');
    const [mail] = (await sent('trip.dispatched')).filter((m) => m.channel === 'email' && m.toName === 'Felix Finance');
    assert.equal(mail!.status, 'queued', 'waiting to be retried');
    assert.equal(mail!.attempts, 1);
    assert.match(mail!.note!, /421 Try again later/);
    assert.ok(mail!.nextAttemptAt! > new Date());

    smtp.failures = 0;
    await OutboundMessage.updateOne({ _id: mail!._id }, { nextAttemptAt: new Date(Date.now() - 1000) });
    await processDue();
    const retried = await OutboundMessage.findById(mail!._id).lean();
    assert.equal(retried!.status, 'sent');
    assert.equal(retried!.attempts, 2);
  });

  test('a rule left pointing at an archived template does not stop the step either', async () => {
    // The master refuses to archive a template a rule uses, so this is a record changed behind its back.
    await MessageTemplate.updateOne({ code: 'T-EM-0' }, { status: 'archived' });
    const trip = await newTrip();
    await fundAndDispatch(trip);
    const out = await sent('trip.dispatched');
    assert.ok(out.length > 0 && out.every((m) => m.channel === 'sms'), 'the archived e-mail template is left out');
  });
});

describe('printouts', () => {
  test('a PDF with a correct cross-reference, page breaks and escaped text', () => {
    const rows = Array.from({ length: 120 }, (_, i) => [`Row ${i}`, 'Kurasini (Dar) \\ jetty', `${i * 10} L`]);
    const pdf = renderPdf([
      { kind: 'title', text: 'Trip sheet TRIP/26/0001' },
      { kind: 'facts', rows: [['Driver', 'Joseph Mwansa'], ['Route', 'Dar es Salaam – Lusaka · 1,961 km at 20 °C €']] },
      { kind: 'table', columns: [{ label: 'A', width: 1 }, { label: 'B', width: 2 }, { label: 'C', width: 1, align: 'right' }], rows },
      { kind: 'signatures', labels: ['Operations', 'Finance', 'Driver'] },
    ], { paperSize: 'A4', footerText: 'Marichi Fleet' });
    const text = pdf.toString('latin1');
    assert.ok(text.startsWith('%PDF-1.4') && text.trimEnd().endsWith('%%EOF'));
    const pages = Number(/\/Count (\d+)/.exec(text)![1]);
    assert.ok(pages >= 3, `120 rows need several pages, got ${pages}`);
    assert.match(text, /Page 1 of \d+/);
    assert.match(text, /\(Kurasini \\\(Dar\\\) \\\\ jetty\)/, 'brackets and backslashes are escaped');
    assert.match(text, /\\226/, 'the en dash is the WinAnsi byte');
    // Every entry in the cross-reference table points at its object.
    const xrefAt = Number(/startxref\n(\d+)/.exec(text)![1]);
    const entries = text.slice(xrefAt).split('\n').filter((l) => / 00000 n $/.test(l)).map((l) => Number(l.slice(0, 10)));
    entries.forEach((offset, i) => assert.ok(text.startsWith(`${i + 1} 0 obj`, offset), `object ${i + 1} is not at ${offset}`));
  });
});
