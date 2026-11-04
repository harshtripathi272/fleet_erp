// #61: customer rates, invoices from closed trips, payments received, and the realised exchange gain or loss.
// Money conversions follow Money settings: the rate basis, and through a pivot currency (USD) when there is no direct rate.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { settleSends } from '../src/modules/messaging/dispatcher.js';
import { ensureBillingMessages } from '../src/modules/messaging/defaults.js';
import { OutboundMessage } from '../src/modules/messaging/models/connection.model.js';
import { toBase } from '../src/modules/operations/support.js';
import { ExchangeDifference } from '../src/modules/finance/billing/billing.model.js';
import { api, bearer, find, loadSample, resetDatabase, signUp, startDatabase, stopDatabase, userWithRole, type Session } from './helpers.js';

let owner: Session, ops: Session, fin: Session;
const ids: Record<string, string> = {};
type Trip = { id: string; number: string };

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

async function switchBillingOn() {
  const company = ok(await as(owner).get('/company'));
  ok(await as(owner).put('/company', { modules: [...company.modules, 'billing'], version: company.version }));
}

async function rate(base: string, quote: string, value: number, day: string) {
  ok(await as(fin).post('/exchange-rates', { baseCurrencyId: ids[base], quoteCurrencyId: ids[quote], rate: value, effectiveDate: day, source: 'bank' }), 201);
}

async function customerRate(body: Record<string, unknown>) {
  return ok(await as(fin).post('/customer-rates', { code: `R-${Math.random().toString(36).slice(2, 8)}`, name: 'Zambezi freight', customerId: ids.zambezi, validFrom: '2026-01-01', ...body }), 201);
}

/** A diesel trip from the depot to Dar es Salaam: funded, loaded with 38,000 L, delivered (`deliveredL`), closed. */
async function closedTrip(deliveredL = 38000, vehicle = 'v1', driver = 'd1'): Promise<Trip> {
  ok(await as(ops).put(`/vehicle-states/${ids[vehicle]}`, { placeId: ids.depot, fuelL: 200 }));
  const trip = ok(await as(ops).post('/trips', {
    customerId: ids.zambezi, vehicleId: ids[vehicle], driverId: ids[driver], routeId: ids.routeDar, plannedStart: '2026-11-03T06:00:00.000Z', productId: ids.diesel,
  }), 201);
  const f = ok(await as(ops).get(`/trips/${trip.id}/funding`));
  const fuel = ok(await as(ops).post('/fund-requests', { tripId: trip.id, kind: 'fuel', litres: f.fuel.suggested }), 201);
  ok(await as(fin).post(`/fund-requests/${fuel.id}/decide`, { approve: true }));
  ok(await as(fin).post(`/fund-requests/${fuel.id}/issue`, { paymentMethodId: ids.pmDepot, reference: 'DP-1' }));
  ok(await as(ops).post(`/trips/${trip.id}/dispatch`));
  const load = ok(await as(ops).post('/consignments', { tripId: trip.id, productId: ids.diesel, invoiceNo: 'LD-1', qty: 38000, ambientL: 38000, tempC: 20, density: 835 }), 201);
  ok(await as(ops).post(`/consignments/${load.id}/delivery`, { podNo: 'POD-1', qty: deliveredL, ambientL: deliveredL, tempC: 20, density: 835, ...(deliveredL === 38000 ? { certStd20L: load.load.std20L } : {}) }));
  ok(await as(ops).post(`/trips/${trip.id}/end`, { closingFuelL: 120 }));
  return trip;
}

const invoicesOf = async (trip: Trip) => ok<{ data: any[] }>(await as(fin).get('/invoices')).data.filter((i) => i.tripIds.includes(trip.id));

before(startDatabase);
after(stopDatabase);
beforeEach(async () => {
  await resetDatabase();
  owner = await signUp('Owner');
  await loadSample(owner);
  ops = await userWithRole(owner, 'operations', 'Olivia Ops');
  fin = await userWithRole(owner, 'finance', 'Felix Finance');
  const lookups: Array<[string, string, string]> = [
    ['zambezi', 'parties', 'Zambezi'], ['v1', 'vehicles', 'ALC 4821'], ['d1', 'drivers', 'Joseph'], ['routeDar', 'routes', 'DAR-LSK'],
    ['depot', 'places', 'LSK-DEPOT'], ['diesel', 'products', 'DIESEL-50'], ['pmDepot', 'payment-methods', 'DEPOT'], ['pmCash', 'payment-methods', 'CASH'],
    ['ZMW', 'currencies', 'ZMW'], ['USD', 'currencies', 'USD'], ['TZS', 'currencies', 'TZS'],
  ];
  for (const [key, master, search] of lookups) ids[key] = (await find(owner, master, search)).id;
});

describe('billing is an area', () => {
  test('it is off until the company switches it on', async () => {
    const res = await as(fin).get('/invoices');
    assert.equal(res.status, 403);
    assert.match(res.body.error.message, /Billing is switched off/);
    assert.equal((await as(fin).post('/payments-received', {})).status, 403);
    ok(await as(fin).get('/customer-rates')); // rates are kept while it is off
    await switchBillingOn();
    ok(await as(fin).get('/invoices'));
  });
});

describe('conversions follow Money settings', () => {
  test('a TZS amount converts through USD when that setting is on, and is refused with a clear message when it is off', async () => {
    // The sample has USD→ZMW 26.45 and USD→TZS 2,710, and no TZS→ZMW rate.
    const convert = () => as(fin).get(`/exchange-rates/convert?fromCurrencyId=${ids.TZS}&toCurrencyId=${ids.ZMW}&amountMinor=271000000`);
    const settings = ok(await as(fin).get('/finance-settings'));
    assert.equal(settings.money.viaPivot, true, 'on by default');
    assert.equal(settings.money.pivotCurrencyCode, 'USD', 'through USD by default');
    const through = ok(await convert());
    assert.equal(through.method, 'pivot');
    assert.equal(through.via, 'USD');
    assert.equal(through.resultMinor, 2_645_000, 'TZS 2,710,000.00 is USD 1,000.00 is ZMW 26,450.00');
    // A driver advance or expense in TZS goes to the base currency the same way.
    assert.equal((await toBase(271_000_000, ids.TZS)).baseMinor, 2_645_000);

    ok(await as(fin).put('/finance-settings', { money: { viaPivot: false }, version: settings.version }));
    const refused = await convert();
    assert.equal(refused.status, 404);
    assert.match(refused.body.error.message, /^No TZS→ZMW rate on or before \d{4}-\d\d-\d\d, and converting through another currency is switched off \(Money settings\)$/);
    await assert.rejects(toBase(271_000_000, ids.TZS), /switched off \(Money settings\)\. Add the rate under Exchange rates\./);
  });

  test('the buying or selling rate is used when chosen, and the mid rate when a day has none', async () => {
    ok(await as(fin).post('/exchange-rates', { baseCurrencyId: ids.USD, quoteCurrencyId: ids.ZMW, rate: 20, buyingRate: 19.8, sellingRate: 20.2, effectiveDate: '2026-02-01', source: 'bank' }), 201);
    const convert = async () => ok(await as(fin).get(`/exchange-rates/convert?fromCurrencyId=${ids.USD}&toCurrencyId=${ids.ZMW}&amountMinor=10000&date=2026-02-02`)).resultMinor;
    assert.equal(await convert(), 200_000);
    const { version } = ok(await as(fin).put('/finance-settings', { money: { rateBasis: 'selling' } }));
    assert.equal(await convert(), 202_000);
    ok(await as(fin).put('/finance-settings', { money: { rateBasis: 'buying' }, version }));
    assert.equal(await convert(), 198_000);
    const stale = await as(fin).put('/finance-settings', { money: { rateBasis: 'mid' }, version });
    assert.equal(stale.status, 409, 'an edit from an old version is refused');
  });
});

describe('invoices from closed trips', () => {
  test('a USD invoice paid in two parts at different rates records the right gain or loss in ZMW', async () => {
    await switchBillingOn();
    await rate('USD', 'ZMW', 20, '2026-01-10');
    await rate('USD', 'ZMW', 21, '2026-02-10');
    await rate('USD', 'ZMW', 19.5, '2026-03-10');
    // Zambezi is billed in USD (its party record); USD 1,000.00 a trip.
    await customerRate({ basis: 'per_trip', price: { amountMinor: 1_000_00, currencyId: ids.USD } });

    const trip = await closedTrip();
    const [draft] = await invoicesOf(trip);
    assert.ok(draft, 'closing the trip drafted its invoice (Invoice from: each closed trip)');
    assert.equal(draft.status, 'draft');
    assert.equal(draft.currency, 'USD');
    assert.equal(draft.totalMinor, 1_000_00);
    const dated = ok(await as(fin).patch(`/invoices/${draft.id}`, { version: draft.version, date: '2026-01-10' }));
    const invoice = ok(await as(fin).post(`/invoices/${draft.id}/approve`, { version: dated.version }));
    assert.match(invoice.number, /^INV\/26\/\d{4}$/);
    assert.equal(invoice.rateToBase, 20);
    assert.equal(invoice.baseTotalMinor, 20_000_00, 'USD 1,000.00 at 20.00 is ZMW 20,000.00');
    assert.equal(invoice.dueDate.slice(0, 10), '2026-02-09', '30 days, the customer\'s terms');

    // USD 600.00 on 10 Feb at 21.00: ZMW 12,600.00 received for ZMW 12,000.00 booked, a gain of ZMW 600.00.
    const first = ok(await as(fin).post('/payments-received', {
      customerId: ids.zambezi, date: '2026-02-10', amount: { amountMinor: 600_00, currencyId: ids.USD }, paymentMethodId: ids.pmCash, reference: 'RC-1',
      allocations: [{ invoiceId: invoice.id, amountMinor: 600_00 }],
    }), 201);
    assert.deepEqual(first.allocations.map((a: any) => [a.settledMinor, a.bookedBaseMinor, a.receivedBaseMinor, a.gainLossBaseMinor]), [[600_00, 12_000_00, 12_600_00, 600_00]]);
    let now = ok(await as(fin).get(`/invoices/${invoice.id}`));
    assert.equal(now.openMinor, 400_00);
    assert.equal(now.baseOpenMinor, 8_000_00);
    assert.equal(now.paymentState, 'part_paid');

    // USD 400.00 on 10 Mar at 19.50: ZMW 7,800.00 received for the ZMW 8,000.00 still booked, a loss of ZMW 200.00.
    const second = ok(await as(fin).post('/payments-received', { customerId: ids.zambezi, date: '2026-03-10', amount: { amountMinor: 400_00, currencyId: ids.USD } }), 201);
    assert.deepEqual(second.allocations.map((a: any) => [a.invoiceId, a.settledMinor, a.bookedBaseMinor, a.receivedBaseMinor, a.gainLossBaseMinor]), [[invoice.id, 400_00, 8_000_00, 7_800_00, -200_00]], 'set against the oldest open invoice');
    now = ok(await as(fin).get(`/invoices/${invoice.id}`));
    assert.equal(now.openMinor, 0);
    assert.equal(now.baseOpenMinor, 0);
    assert.equal(now.paymentState, 'paid');
    assert.equal(now.payments.length, 2);

    const differences = await ExchangeDifference.find({ invoiceId: invoice.id }).sort({ date: 1 }).lean<Array<{ kind: string; amountMinor: number }>>();
    assert.deepEqual(differences.map((d) => [d.kind, d.amountMinor]), [['realised', 600_00], ['realised', -200_00]]);
    assert.equal(differences.reduce((s, d) => s + d.amountMinor, 0), 400_00, 'a net gain of ZMW 400.00');
    const listed = ok(await as(fin).get(`/exchange-differences?invoiceId=${invoice.id}`));
    assert.equal(listed.total, 2);

    const over = await as(fin).post('/payments-received', { customerId: ids.zambezi, date: '2026-03-11', amount: { amountMinor: 1_00, currencyId: ids.USD }, allocations: [{ invoiceId: invoice.id, amountMinor: 1_00 }] });
    assert.equal(over.status, 422, 'a paid invoice takes no more');
  });

  test('a payment in ZMW against a USD invoice settles it at the payment day\'s rate', async () => {
    await switchBillingOn();
    await rate('USD', 'ZMW', 20, '2026-01-10');
    await rate('USD', 'ZMW', 25, '2026-02-10');
    await customerRate({ basis: 'per_trip', price: { amountMinor: 1_000_00, currencyId: ids.USD } });
    const [draft] = await invoicesOf(await closedTrip());
    const dated = ok(await as(fin).patch(`/invoices/${draft.id}`, { version: draft.version, date: '2026-01-10' }));
    const invoice = ok(await as(fin).post(`/invoices/${draft.id}/approve`, { version: dated.version }));
    // ZMW 12,500.00 at 25.00 settles USD 500.00, booked at ZMW 10,000.00: a gain of ZMW 2,500.00.
    const paid = ok(await as(fin).post('/payments-received', { customerId: ids.zambezi, date: '2026-02-10', amount: { amountMinor: 12_500_00, currencyId: ids.ZMW } }), 201);
    assert.deepEqual(paid.allocations.map((a: any) => [a.amountMinor, a.settledMinor, a.bookedBaseMinor, a.receivedBaseMinor, a.gainLossBaseMinor]), [[12_500_00, 500_00, 10_000_00, 12_500_00, 2_500_00]]);
    assert.equal(paid.unallocatedMinor, 0);
    assert.equal(ok(await as(fin).get(`/invoices/${invoice.id}`)).openMinor, 500_00);
  });

  test('per litre at 20 °C on the delivered quantity, less the shortage, with VAT, sent with its PDF, and credited', async () => {
    await switchBillingOn();
    const { version } = ok(await as(fin).get('/finance-settings'));
    ok(await as(fin).put('/finance-settings', { billing: { taxMode: 'single', taxRatePercent: 16 }, version }));
    // ZMW 0.50 a litre at 20 °C, at least ZMW 25,000.00 a trip; billed in ZMW for this test.
    const party = ok(await as(owner).get(`/parties/${ids.zambezi}`));
    ok(await as(owner).patch(`/parties/${ids.zambezi}`, { currencyId: ids.ZMW, contacts: [...party.contacts.map(({ id: _a, _id: _b, ...c }: any) => c), { name: 'Accounts', email: 'accounts@zambezi.example', receives: ['invoices'] }], version: party.version }));
    await customerRate({ basis: 'per_litre_20', price: { amountMinor: 50, currencyId: ids.ZMW }, minimumCharge: { amountMinor: 25_000_00, currencyId: ids.ZMW }, routeId: ids.routeDar, productId: ids.diesel });
    await customerRate({ basis: 'per_trip', price: { amountMinor: 1, currencyId: ids.ZMW } }); // a rate for any route loses to the route's own

    // 38,000 L loaded, 37,800 L delivered: 200 L lost, 114 L allowed (0.3 %), 86 L charged at ZMW 31.00.
    const trip = await closedTrip(37800);
    const [draft] = await invoicesOf(trip);
    const lines = draft.lines.map((l: any) => [l.kind, l.qty, l.unitPriceMinor, l.amountMinor, l.taxMinor]);
    assert.deepEqual(lines, [
      ['freight', 37800, 50, 18_900_00, 3_024_00],
      ['minimum', 1, 6_100_00, 6_100_00, 976_00],
      ['shortage', 86, -31_00, -2_666_00, -426_56],
    ]);
    assert.equal(draft.netMinor, 22_334_00);
    assert.equal(draft.taxMinor, 3_573_44);
    assert.equal(draft.totalMinor, 25_907_44);

    const invoice = ok(await as(fin).post(`/invoices/${draft.id}/approve`, { version: draft.version }));
    assert.equal(invoice.rateToBase, 1);
    await ensureBillingMessages();
    const sent = ok(await as(fin).post(`/invoices/${invoice.id}/send`));
    assert.equal(sent.messages, 1);
    await settleSends();
    const mail = await OutboundMessage.findOne({ event: 'invoice.sent' }).lean();
    assert.equal(mail?.to, 'accounts@zambezi.example', 'the contact who receives invoices');
    assert.match(String(mail?.subject), new RegExp(`invoice ${invoice.number.replace(/\//g, '\\/')}$`));
    assert.equal((mail as any)?.attachments?.[0]?.name, `Invoice ${invoice.number.replace(/\//g, '-')}.pdf`);
    const pdf = await as(fin).get(`/invoices/${invoice.id}/pdf`).buffer(true).parse((res, done) => { const parts: Buffer[] = []; res.on('data', (c: Buffer) => parts.push(c)); res.on('end', () => done(null, Buffer.concat(parts))); });
    assert.equal(pdf.status, 200);
    assert.equal(String(pdf.body.subarray(0, 5)), '%PDF-');

    // A credit for the minimum-charge top-up.
    const credit = ok(await as(fin).post(`/invoices/${invoice.id}/credit-notes`, { reason: 'Minimum charge waived', lines: [{ kind: 'minimum', description: 'Minimum charge waived', qty: 1, unitPriceMinor: 6_100_00, taxPercent: 16 }] }), 201);
    assert.equal(credit.totalMinor, 7_076_00);
    const approved = ok(await as(fin).post(`/invoices/${credit.id}/approve`, { version: credit.version }));
    assert.match(approved.number, /^CRN\/\d\d\/\d{4}$/);
    const after = ok(await as(fin).get(`/invoices/${invoice.id}`));
    assert.equal(after.openMinor, 25_907_44 - 7_076_00);
    assert.equal(after.creditedMinor, 7_076_00);
    assert.equal(after.creditNotes.length, 1);
    const tooMuch = await as(fin).post(`/invoices/${invoice.id}/credit-notes`, { reason: 'All of it', lines: [{ description: 'Everything', qty: 1, unitPriceMinor: 30_000_00 }] });
    assert.equal(tooMuch.status, 422);

    const edit = await as(fin).patch(`/invoices/${invoice.id}`, { version: after.version, note: 'Late change' });
    assert.equal(edit.status, 409, 'an approved invoice is corrected with a credit note, not edited');
  });

  test('a trip with no rate waits in the list of trips to invoice, saying why', async () => {
    await switchBillingOn();
    const trip = await closedTrip();
    assert.equal((await invoicesOf(trip)).length, 0);
    const waiting = ok(await as(fin).get('/invoices/unbilled-trips'));
    const row = waiting.data.find((t: any) => t.id === trip.id);
    assert.match(row.problem, new RegExp(`^No customer rate covers ${trip.number.replace(/\//g, '\\/')} on \\d{4}-\\d\\d-\\d\\d\\. Add one under Customer rates\\.$`));

    await customerRate({ basis: 'per_tonne', price: { amountMinor: 45_00, currencyId: ids.USD } });
    const drafted = ok(await as(fin).post('/invoices/draft', { tripIds: [trip.id] }));
    assert.equal(drafted.drafted.length, 1);
    // 38,000 L at 20 °C × 0.835 kg/L = 31.73 t, at USD 45.00.
    assert.deepEqual(drafted.drafted[0].lines.map((l: any) => [l.qty, l.unit, l.amountMinor]), [[31.73, 't', 1_427_85]]);
    const again = ok(await as(fin).post('/invoices/draft', { tripIds: [trip.id] }));
    assert.deepEqual(again.skipped.map((s: any) => s.reason), [`${trip.number} is already invoiced.`]);
    assert.equal(ok(await as(fin).get('/invoices/unbilled-trips')).data.some((t: any) => t.id === trip.id), false);
  });

  test('on demand: closing a trip drafts nothing; the office drafts one invoice for the customer\'s trips', async () => {
    await switchBillingOn();
    const { version } = ok(await as(fin).get('/finance-settings'));
    ok(await as(fin).put('/finance-settings', { billing: { invoiceFrom: 'on_demand' }, version }));
    await customerRate({ basis: 'per_trip', price: { amountMinor: 900_00, currencyId: ids.USD } });
    const trip = await closedTrip();
    assert.equal((await invoicesOf(trip)).length, 0);
    const drafted = ok(await as(fin).post('/invoices/draft', { customerId: ids.zambezi }));
    assert.equal(drafted.drafted.length, 1);
    assert.deepEqual(drafted.drafted[0].tripIds, [trip.id]);
    const cancelled = ok(await as(fin).post(`/invoices/${drafted.drafted[0].id}/cancel`, { version: drafted.drafted[0].version, reason: 'Wrong customer' }));
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(ok(await as(fin).post('/invoices/draft', { tripIds: [trip.id] })).drafted.length, 1, 'a cancelled draft frees its trips');
  });

  test('Operations may read invoices but not raise them', async () => {
    await switchBillingOn();
    ok(await as(ops).get('/invoices'));
    assert.equal((await as(ops).post('/invoices/draft', {})).status, 403);
    assert.equal((await as(ops).put('/finance-settings', { money: { viaPivot: false } })).status, 403);
  });
});
