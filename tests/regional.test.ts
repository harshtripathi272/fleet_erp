// #72: any country, any currency, any clock. The company's regional settings (or its country's) decide how
// every date, time, number and amount is written, on screens, documents and messages.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import * as Fmt from '../src/core/format/regional.js';
import { Message } from '../src/modules/operations/models/message.model.js';
import { api, bearer, find, loadSample, resetDatabase, signUp, startDatabase, stopDatabase, type Session } from './helpers.js';

let owner: Session;
const ids: Record<string, string> = {};
const as = (s: { token: string }) => ({
  get: (path: string) => api().get(`/api/v1${path}`).set(bearer(s)),
  post: (path: string, body: unknown = {}) => api().post(`/api/v1${path}`).set(bearer(s)).send(body as object),
  put: (path: string, body: unknown) => api().put(`/api/v1${path}`).set(bearer(s)).send(body as object),
});
const ok = <T = any>(res: { status: number; body: any }, status = 200): T => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body.data as T;
};
const binary = (res: any, done: (err: null, body: Buffer) => void) => { const parts: Buffer[] = []; res.on('data', (c: Buffer) => parts.push(c)); res.on('end', () => done(null, Buffer.concat(parts))); };

/** The company moves to Tanzania: base currency TZS, ISO dates, and its country's clock and dialling code. */
async function inTanzania(extra: Record<string, unknown> = {}) {
  const tz = await find(owner, 'countries', 'Tanzania'); // in the sample: +255, Africa/Dar_es_Salaam
  // Budgets are kept in kwacha in the sample; a direct rate lets them convert to the new base currency.
  ok(await as(owner).post('/exchange-rates', { baseCurrencyId: ids.ZMW, quoteCurrencyId: ids.TZS, rate: 102.46, effectiveDate: '2026-01-01', source: 'bank' }), 201);
  const company = ok(await as(owner).get('/company'));
  return ok(await as(owner).put('/company', { countryId: tz.id, baseCurrencyId: ids.TZS, timezone: null, dateFormat: 'YYYY-MM-DD', version: company.version, ...extra }));
}

before(startDatabase);
after(stopDatabase);
beforeEach(async () => {
  await resetDatabase();
  owner = await signUp('Owner');
  await loadSample(owner);
  for (const [key, master, search] of [
    ['TZS', 'currencies', 'TZS'], ['ZMW', 'currencies', 'ZMW'], ['zambezi', 'parties', 'Zambezi'], ['v1', 'vehicles', 'ALC 4821'],
    ['d1', 'drivers', 'Joseph'], ['routeDar', 'routes', 'DAR-LSK'], ['diesel', 'products', 'DIESEL-50'], ['template', 'message-templates', 'WA-ADV-REQ'],
  ] as const) ids[key] = (await find(owner, master, search)).id;
});

describe('the formatter', () => {
  const r = (over: Partial<Fmt.Regional>) => ({ ...Fmt.REGIONAL_DEFAULTS, ...over });
  const at = new Date('2026-11-03T21:30:00.000Z');

  test('dates and times follow the format and the time zone', () => {
    assert.equal(Fmt.date(at, r({})), '03/11/2026', 'UTC, day first');
    assert.equal(Fmt.date(at, r({ timeZone: 'Africa/Dar_es_Salaam', dateFormat: 'YYYY-MM-DD' })), '2026-11-04', 'already the 4th in Dar es Salaam');
    assert.equal(Fmt.date(at, r({ dateFormat: 'MM/DD/YYYY' })), '11/03/2026');
    assert.equal(Fmt.time(at, r({ timeZone: 'Africa/Dar_es_Salaam' })), '00:30');
    assert.equal(Fmt.time(at, r({ timeFormat: '12h' })), '9:30 pm');
    assert.equal(Fmt.dateTime(at, r({ timeZone: 'America/New_York', dateFormat: 'YYYY-MM-DD', timeFormat: '12h' })), '2026-11-03 4:30 pm');
    assert.equal(Fmt.date(at, r({ timeZone: 'Not/AZone' })), '03/11/2026', 'an unknown zone falls back to UTC');
  });

  test('numbers and amounts use the separators chosen', () => {
    assert.equal(Fmt.money(1_250_050, { code: 'TZS', minorUnits: 2 }, r({})), '12,500.5 TZS');
    assert.equal(Fmt.money(1_250_050, { code: 'EUR', minorUnits: 2 }, r({ decimalSeparator: ',', thousandsSeparator: '.' })), '12.500,5 EUR');
    assert.equal(Fmt.amount(1_250_050, 2, r({ decimalSeparator: ',', thousandsSeparator: ' ' })), '12 500,50');
    assert.equal(Fmt.number(-0, 0, r({})), '0');
  });

  test('the financial year starts in the company\'s month', () => {
    const april = r({ fiscalYearStartMonth: 4 });
    assert.equal(Fmt.financialYearStart(new Date('2026-03-31T12:00:00Z'), april).toISOString().slice(0, 10), '2025-04-01');
    assert.equal(Fmt.financialYearStart(new Date('2026-04-01T12:00:00Z'), april).toISOString().slice(0, 10), '2026-04-01');
    assert.equal(Fmt.financialYearStart(new Date('2026-06-15T12:00:00Z'), r({})).toISOString().slice(0, 10), '2026-01-01');
  });
});

describe('a company in Tanzania', () => {
  test('its settings follow the country unless it chooses its own', async () => {
    const company = await inTanzania();
    assert.equal(company.timezone, undefined, 'no time zone of its own');
    assert.deepEqual(
      [company.effectiveRegional.timeZone, company.effectiveRegional.dateFormat, company.effectiveRegional.phoneCountryCode],
      ['Africa/Dar_es_Salaam', 'YYYY-MM-DD', '+255'],
    );
    const own = ok(await as(owner).put('/company', { timezone: 'Africa/Nairobi', regional: { timeFormat: '12h', phoneCountryCode: '+254' }, version: company.version }));
    assert.deepEqual([own.effectiveRegional.timeZone, own.effectiveRegional.timeFormat, own.effectiveRegional.phoneCountryCode], ['Africa/Nairobi', '12h', '+254']);
    const back = ok(await as(owner).put('/company', { timezone: null, regional: { phoneCountryCode: null }, version: own.version }));
    assert.deepEqual([back.effectiveRegional.timeZone, back.effectiveRegional.timeFormat, back.effectiveRegional.phoneCountryCode], ['Africa/Dar_es_Salaam', '12h', '+255'], 'cleared settings go back to the country\'s; the others stay');
    const same = await as(owner).put('/company', { regional: { decimalSeparator: ',', thousandsSeparator: ',' }, version: back.version });
    assert.equal(same.status, 422, 'the two separators must differ');
  });

  test('messages show TZS, ISO dates and Dar es Salaam time', async () => {
    await inTanzania();
    // 06:00 UTC is 09:00 in Dar es Salaam.
    ok(await as(owner).put(`/vehicle-states/${ids.v1}`, { placeId: (await find(owner, 'places', 'LSK-DEPOT')).id, fuelL: 200 }));
    const trip = ok(await as(owner).post('/trips', { customerId: ids.zambezi, vehicleId: ids.v1, driverId: ids.d1, routeId: ids.routeDar, plannedStart: '2026-11-03T06:00:00.000Z', productId: ids.diesel }), 201);
    const message = await Message.findOne({ thread: `driver:${ids.d1}`, title: `New trip ${trip.number}` }).lean<{ rows: string[][] }>();
    assert.deepEqual(message?.rows, [['Planned start', '2026-11-03 09:00']]);

    const preview = ok(await as(owner).post(`/message-templates/${ids.template}/preview`, {}));
    const text = JSON.stringify(preview);
    assert.match(text, /TZS/);
    assert.doesNotMatch(text, /ZMW/);
    const today = Fmt.date(new Date(), { ...Fmt.REGIONAL_DEFAULTS, timeZone: 'Africa/Dar_es_Salaam', dateFormat: 'YYYY-MM-DD' });
    assert.equal(Fmt.date(new Date()), today, 'the formatter took the company\'s settings');
  });

  test('the trip sheet PDF is in TZS, with no kwacha left in it', async () => {
    await inTanzania({ regional: { decimalSeparator: ',', thousandsSeparator: '.' } });
    ok(await as(owner).put(`/vehicle-states/${ids.v1}`, { placeId: (await find(owner, 'places', 'LSK-DEPOT')).id, fuelL: 200 }));
    const trip = ok(await as(owner).post('/trips', { customerId: ids.zambezi, vehicleId: ids.v1, driverId: ids.d1, routeId: ids.routeDar, plannedStart: '2026-11-03T06:00:00.000Z', productId: ids.diesel }), 201);
    ok(await as(owner).post('/fund-requests', { tripId: trip.id, kind: 'cash', amount: { amountMinor: 1_250_050_00, currencyId: ids.TZS }, reason: 'Border fees' }), 201);
    const pdf = await as(owner).get(`/trips/${trip.id}/sheet.pdf`).buffer(true).parse(binary);
    assert.equal(pdf.status, 200);
    const text = pdf.body.toString('latin1');
    assert.ok(text.includes('1.250.050 TZS'), 'the advance in TZS, with dots between thousands');
    assert.doesNotMatch(text, /ZMW/);
  });
});
