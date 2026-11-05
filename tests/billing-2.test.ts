// #62: revaluation of open foreign-currency invoices, customer statements and ageing, and the accounting export.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { AccountCode, ExchangeDifference, Invoice } from '../src/modules/finance/billing/billing.model.js';
import { lastPeriodEnd } from '../src/modules/finance/billing/revaluation.service.js';
import { ensureBillingMessages } from '../src/modules/messaging/defaults.js';
import { settleSends } from '../src/modules/messaging/dispatcher.js';
import { OutboundMessage } from '../src/modules/messaging/models/connection.model.js';
import { api, bearer, find, loadSample, resetDatabase, signUp, startDatabase, stopDatabase, userWithRole, type Session } from './helpers.js';

let owner: Session, ops: Session, fin: Session;
const ids: Record<string, string> = {};

const as = (s: { token: string }) => ({
  get: (path: string) => api().get(`/api/v1${path}`).set(bearer(s)),
  post: (path: string, body: unknown = {}) => api().post(`/api/v1${path}`).set(bearer(s)).send(body as object),
  put: (path: string, body: unknown) => api().put(`/api/v1${path}`).set(bearer(s)).send(body as object),
  patch: (path: string, body: unknown) => api().patch(`/api/v1${path}`).set(bearer(s)).send(body as object),
});
const ok = <T = any>(res: { status: number; body: any }, status = 200): T => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body.data as T;
};
const binary = (res: any, done: (err: null, body: Buffer) => void) => { const parts: Buffer[] = []; res.on('data', (c: Buffer) => parts.push(c)); res.on('end', () => done(null, Buffer.concat(parts))); };

async function rate(value: number, day: string) {
  ok(await as(fin).post('/exchange-rates', { baseCurrencyId: ids.USD, quoteCurrencyId: ids.ZMW, rate: value, effectiveDate: day, source: 'bank' }), 201);
}

/** A closed diesel trip for Zambezi, with ZMW 1,500.00 cash advanced to the driver. */
async function closedTrip() {
  ok(await as(ops).put(`/vehicle-states/${ids.v1}`, { placeId: ids.depot, fuelL: 200 }));
  const trip = ok(await as(ops).post('/trips', { customerId: ids.zambezi, vehicleId: ids.v1, driverId: ids.d1, routeId: ids.routeDar, plannedStart: '2026-11-03T06:00:00.000Z', productId: ids.diesel }), 201);
  const f = ok(await as(ops).get(`/trips/${trip.id}/funding`));
  const fuel = ok(await as(ops).post('/fund-requests', { tripId: trip.id, kind: 'fuel', litres: f.fuel.suggested }), 201);
  const cash = ok(await as(ops).post('/fund-requests', { tripId: trip.id, kind: 'cash', amount: { amountMinor: 1_500_00, currencyId: ids.ZMW } }), 201);
  for (const r of [fuel, cash]) ok(await as(fin).post(`/fund-requests/${r.id}/decide`, { approve: true }));
  ok(await as(fin).post(`/fund-requests/${fuel.id}/issue`, { paymentMethodId: ids.pmDepot, reference: 'DP-1' }));
  ok(await as(fin).post(`/fund-requests/${cash.id}/issue`, { paymentMethodId: ids.pmCash }));
  ok(await as(ops).post(`/trips/${trip.id}/dispatch`));
  const load = ok(await as(ops).post('/consignments', { tripId: trip.id, productId: ids.diesel, invoiceNo: 'LD-1', qty: 38000, ambientL: 38000, tempC: 20, density: 835 }), 201);
  ok(await as(ops).post(`/consignments/${load.id}/delivery`, { podNo: 'POD-1', qty: 38000, ambientL: 38000, tempC: 20, density: 835, certStd20L: load.load.std20L }));
  ok(await as(ops).post(`/trips/${trip.id}/end`, { closingFuelL: 120 }));
  return trip;
}

/** A USD 1,000.00 invoice for a closed trip, dated and approved. */
async function invoiceOn(day: string) {
  const trip = await closedTrip();
  const draft = (await Invoice.findOne({ tripIds: trip.id }).lean()) as any;
  const dated = ok(await as(fin).patch(`/invoices/${draft._id}`, { version: draft.version, date: day }));
  return ok(await as(fin).post(`/invoices/${dated.id}/approve`, { version: dated.version }));
}
const pay = async (invoiceId: string, amountMinor: number, date: string) =>
  ok(await as(fin).post('/payments-received', { customerId: ids.zambezi, date, amount: { amountMinor, currencyId: ids.USD }, allocations: [{ invoiceId, amountMinor }] }), 201);

before(startDatabase);
after(stopDatabase);
beforeEach(async () => {
  await resetDatabase();
  owner = await signUp('Owner');
  await loadSample(owner);
  ops = await userWithRole(owner, 'operations', 'Olivia Ops');
  fin = await userWithRole(owner, 'finance', 'Felix Finance');
  for (const [key, master, search] of [
    ['zambezi', 'parties', 'Zambezi'], ['v1', 'vehicles', 'ALC 4821'], ['d1', 'drivers', 'Joseph'], ['routeDar', 'routes', 'DAR-LSK'],
    ['depot', 'places', 'LSK-DEPOT'], ['diesel', 'products', 'DIESEL-50'], ['pmDepot', 'payment-methods', 'DEPOT'], ['pmCash', 'payment-methods', 'CASH'],
    ['ZMW', 'currencies', 'ZMW'], ['USD', 'currencies', 'USD'],
  ] as const) ids[key] = (await find(owner, master, search)).id;
  const company = ok(await as(owner).get('/company'));
  ok(await as(owner).put('/company', { modules: [...company.modules, 'billing'], version: company.version }));
  ok(await as(fin).post('/customer-rates', { code: 'ZAMBEZI-TRIP', name: 'Zambezi per trip', customerId: ids.zambezi, validFrom: '2026-01-01', basis: 'per_trip', price: { amountMinor: 1_000_00, currencyId: ids.USD } }), 201);
  await rate(20, '2026-01-10');
});

describe('revaluation', () => {
  test('the last month or quarter end', () => {
    const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
    assert.equal(lastPeriodEnd(d('2026-03-15'), 'monthly').toISOString().slice(0, 10), '2026-02-28');
    assert.equal(lastPeriodEnd(d('2026-03-31'), 'monthly').toISOString().slice(0, 10), '2026-03-31');
    assert.equal(lastPeriodEnd(d('2026-01-05'), 'monthly').toISOString().slice(0, 10), '2025-12-31');
    assert.equal(lastPeriodEnd(d('2026-05-10'), 'quarterly').toISOString().slice(0, 10), '2026-03-31');
    assert.equal(lastPeriodEnd(d('2026-02-01'), 'quarterly').toISOString().slice(0, 10), '2025-12-31');
  });

  test('a month-end run revalues an open USD invoice and the next run reverses it', async () => {
    await rate(22, '2026-01-31');
    await rate(21, '2026-02-28');
    const invoice = await invoiceOn('2026-01-10'); // USD 1,000.00 booked at ZMW 20,000.00

    const off = await as(fin).post('/billing/revaluations', {});
    assert.equal(off.status, 422, 'off by default, so a run needs its day');

    // 31 Jan at 22.00: ZMW 22,000.00 against ZMW 20,000.00 booked, an unrealised gain of ZMW 2,000.00.
    const jan = ok(await as(fin).post('/billing/revaluations', { periodEnd: '2026-01-31' }), 201);
    assert.equal(jan.invoices, 1);
    assert.equal(jan.netMinor, 2_000_00);
    assert.equal(jan.reversedMinor, 0);
    assert.equal((await as(fin).post('/billing/revaluations', { periodEnd: '2026-01-31' })).status, 409, 'once per period end');

    // USD 400.00 paid on 15 Feb at 22.00: the realised gain is measured from the invoice's own rate, not the revaluation.
    const paid = await pay(invoice.id, 400_00, '2026-02-15');
    assert.equal(paid.allocations[0].gainLossBaseMinor, 800_00);

    // 28 Feb at 21.00: January's gain is reversed on 1 Feb; USD 600.00 still owed is ZMW 12,600.00 against ZMW 12,000.00 booked.
    const feb = ok(await as(fin).post('/billing/revaluations', { periodEnd: '2026-02-28' }), 201);
    assert.equal(feb.reversedMinor, -2_000_00);
    assert.equal(feb.netMinor, 600_00);
    const entries = await ExchangeDifference.find({ invoiceId: invoice.id, kind: { $ne: 'realised' } }).sort({ date: 1, _id: 1 }).lean<Array<{ kind: string; date: Date; amountMinor: number }>>();
    assert.deepEqual(entries.map((e) => [e.kind, e.date.toISOString().slice(0, 10), e.amountMinor]), [
      ['unrealised', '2026-01-31', 2_000_00],
      ['reversal', '2026-02-01', -2_000_00],
      ['unrealised', '2026-02-28', 600_00],
    ]);
    const now = ok(await as(fin).get(`/invoices/${invoice.id}`));
    assert.equal(now.baseOpenMinor, 12_000_00, 'what the invoice is booked at never changes');

    // A run for an earlier day than one already made is refused.
    assert.equal((await as(fin).post('/billing/revaluations', { periodEnd: '2026-01-15' })).status, 409);
    const listed = ok(await as(fin).get('/billing/revaluations'));
    assert.deepEqual(listed.runs.map((r: any) => r.periodEnd.slice(0, 10)), ['2026-02-28', '2026-01-31']);
    assert.equal(listed.due.due, false);
  });
});

describe('statements and ageing', () => {
  test('the ageing totals match the open invoices, in the company\'s columns', async () => {
    const late = await invoiceOn('2026-01-10'); // due 9 Feb
    const recent = await invoiceOn('2026-03-10'); // due 9 Apr
    await pay(late.id, 250_00, '2026-03-01');

    const aged = ok(await as(fin).get('/billing/ageing?asOf=2026-03-20'));
    assert.deepEqual(aged.buckets.map((b: any) => b.key), ['current', '1-30', '31-60', '61-90', 'over-90']);
    const row = aged.customers.find((c: any) => c.customerId === ids.zambezi);
    assert.equal(row.currency, 'USD');
    assert.deepEqual(row.buckets, { current: 1_000_00, '1-30': 0, '31-60': 750_00, '61-90': 0, 'over-90': 0 }, '39 days late, and not yet due');
    const open = await Invoice.find({ kind: 'invoice', status: 'approved', openMinor: { $gt: 0 } }).lean<Array<{ openMinor: number }>>();
    const owed = open.reduce((s, i) => s + i.openMinor, 0);
    assert.equal(row.totalMinor, owed);
    assert.equal(aged.totals.find((t: any) => t.currency === 'USD').totalMinor, owed);
    assert.equal(Object.values(row.buckets as Record<string, number>).reduce((s, v) => s + v, 0), owed);
    assert.deepEqual(row.invoices.map((i: any) => [i.number, i.daysLate, i.bucket]), [[late.number, 39, '31-60'], [recent.number, 0, 'current']]);

    const { version } = ok(await as(fin).get('/finance-settings'));
    ok(await as(fin).put('/finance-settings', { billing: { ageingBucketsDays: [15, 45] }, version }));
    const custom = ok(await as(fin).get('/billing/ageing?asOf=2026-03-20'));
    assert.deepEqual(custom.buckets.map((b: any) => b.label), ['Current', '1–15 days', '16–45 days', 'Over 45 days']);
    assert.equal(custom.customers[0].buckets['16-45'], 750_00);
  });

  test('a statement carries the balance forward, as PDF and sent to the customer', async () => {
    const first = await invoiceOn('2026-01-10');
    await pay(first.id, 250_00, '2026-02-05');
    const second = await invoiceOn('2026-03-10');

    const s = ok(await as(fin).get(`/billing/statements/${ids.zambezi}?from=2026-02-01&to=2026-03-31`));
    assert.equal(s.currency, 'USD');
    assert.equal(s.openingMinor, 1_000_00, 'January\'s invoice, brought forward');
    assert.deepEqual(s.entries.map((e: any) => [e.number, e.debitMinor, e.creditMinor, e.balanceMinor]), [
      [s.entries[0].number, 0, 250_00, 750_00],
      [second.number, 1_000_00, 0, 1_750_00],
    ]);
    assert.match(s.entries[0].description, new RegExp(`^Payment against ${first.number.replace(/\//g, '\\/')}`));
    assert.equal(s.closingMinor, 1_750_00);

    const pdf = await as(fin).get(`/billing/statements/${ids.zambezi}/pdf?from=2026-02-01&to=2026-03-31`).buffer(true).parse(binary);
    assert.equal(pdf.status, 200);
    assert.equal(String(pdf.body.subarray(0, 5)), '%PDF-');

    await ensureBillingMessages();
    const sent = ok(await as(fin).post(`/billing/statements/${ids.zambezi}/send?from=2026-02-01&to=2026-03-31`));
    assert.equal(sent.messages, 1);
    await settleSends();
    const mail = await OutboundMessage.findOne({ event: 'statement.sent' }).lean();
    assert.equal(mail?.to, 'natasha.banda@zambezi.example');
    assert.match(String(mail?.body), /The balance owed is 1,750(\.00)? USD\./);
    assert.equal(mail?.attachments?.length, 1);
  });
});

describe('the accounting export', () => {
  test('the CSV lists every posting with its account code, and refuses while one has none', async () => {
    await rate(22, '2026-01-31');
    const invoice = await invoiceOn('2026-01-10');
    await pay(invoice.id, 400_00, '2026-02-15'); // a realised gain
    ok(await as(fin).post('/billing/revaluations', { periodEnd: '2026-01-31' }), 201); // an unrealised one

    await AccountCode.deleteMany({}); // the sample's own, so this test sets every code itself
    const codes: Array<[string, string, string[]]> = [
      ['1100', 'Debtors', ['receivables']], ['4000', 'Freight income', ['revenue']], ['2200', 'VAT', ['tax']], ['1000', 'Bank', ['bank']],
      ['7900', 'Exchange differences', ['exchange_loss', 'unrealised_exchange']], ['1300', 'Driver advances', ['driver_advances']], ['6100', 'Trip expenses', ['expenses']],
    ];
    for (const [code, name, postsFor] of codes) ok(await as(fin).post('/account-codes', { code, name, postsFor }), 201);
    const clash = await as(fin).post('/account-codes', { code: '9999', name: 'Twice', postsFor: ['bank'] });
    assert.equal(clash.status, 422, 'each posting goes to one account code');

    const today = new Date().toISOString().slice(0, 10);
    const refused = await as(fin).get(`/billing/export?from=2026-01-01&to=${today}`);
    assert.equal(refused.status, 422);
    assert.equal(refused.body.error.message, 'Give an account code for: Exchange gains (Masters → Account codes).');
    ok(await as(fin).post('/account-codes', { code: '7910', name: 'Exchange gains', postsFor: ['exchange_gain'] }), 201);

    const res = await as(fin).get(`/billing/export?from=2026-01-01&to=${today}`).buffer(true).parse(binary);
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /^text\/csv/);
    const rows = res.body.toString('utf8').replace(/^﻿/, '').trim().split('\r\n').map((r: string) => r.split(','));
    const [header, ...lines] = rows;
    assert.deepEqual(header!.slice(0, 9), ['Date', 'Journal', 'Document', 'Customer or driver', 'Account code', 'Account', 'Details', 'Debit (ZMW)', 'Credit (ZMW)']);
    assert.ok(lines.every((l: string[]) => /^\d{4}$/.test(l[4]!)), 'every posting has its account code');
    const sum = (i: number) => Math.round(lines.reduce((s: number, l: string[]) => s + Number(l[i] || 0), 0) * 100);
    assert.equal(sum(7), sum(8), 'debits equal credits');
    const journals = new Set(lines.map((l: string[]) => l[1]));
    for (const j of ['Invoice', 'Payment received', 'Revaluation', 'Driver advance']) assert.ok(journals.has(j), `${j} is exported`);
    const gain = lines.find((l: string[]) => l[4] === '7910')!;
    assert.deepEqual([gain[1], gain[8]], ['Payment received', '800.00']);
    const invoiceLines = lines.filter((l: string[]) => l[2] === invoice.number && l[1] === 'Invoice');
    assert.deepEqual(invoiceLines.map((l: string[]) => [l[4], l[7], l[8], l[9], l[10]]), [['1100', '20000.00', '', 'USD', '1000.00'], ['4000', '', '20000.00', 'USD', '-1000.00']]);
  });
});
