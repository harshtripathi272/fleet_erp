import { ExchangeRate } from '../src/modules/finance/models/exchangeRate.model.js';
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { env } from '../src/config/env.js';
import { setRateProvider, type RateProvider } from '../src/core/rates/providers.js';
import { companyDay, fetchIsDue, fetchRates } from '../src/modules/finance/rateFeed.service.js';
import { api, bearer, find, loadSample, resetDatabase, signUp, startDatabase, stopDatabase, userWithRole, type Session } from './helpers.js';

/** The daily exchange-rate feed (#22), with a fake provider in place of Open Exchange Rates. */
let owner: Session;
const ids: Record<string, string> = {};
let answer: Record<string, number> = {};
let fail: Error | null = null;
let calls = 0;

const fake: RateProvider = {
  key: 'openexchangerates', label: 'Open Exchange Rates', needsKey: true,
  async fetch({ codes }) {
    calls += 1;
    if (fail) throw fail;
    return { perBase: Object.fromEntries(codes.filter((c) => answer[c]).map((c) => [c, answer[c]!])), asOf: new Date('2031-11-03T05:00:00Z') };
  },
};
const realKey = env.RATE_FEED_API_KEY;
const rates = async (code: string) => (await api().get('/api/v1/exchange-rates').query({ currencyId: ids[code], status: 'all', limit: 50 }).set(bearer(owner)).expect(200)).body.data as Array<Record<string, any>>;

before(async () => {
  await startDatabase();
  setRateProvider(fake);
});
after(stopDatabase);
beforeEach(async () => {
  await resetDatabase();
  owner = await signUp('Owner');
  await loadSample(owner);
  // The sample's rates are dated yesterday, so a fixed day here would meet them on one day of the year.
  await ExchangeRate.deleteMany({});
  for (const code of ['ZMW', 'USD', 'TZS']) ids[code] = (await find(owner, 'currencies', code)).id;
  answer = { USD: 1 / 26.5, TZS: 2710 / 26.5 }; // per 1 ZMW
  fail = null;
  calls = 0;
  env.RATE_FEED_API_KEY = 'test-key';
});
afterEach(() => { env.RATE_FEED_API_KEY = realKey; });

const switchOn = (body: Record<string, unknown> = { provider: 'openexchangerates' }) => api().put('/api/v1/exchange-rates/feed').set(bearer(owner)).send(body);

describe('exchange-rate feed', () => {
  test('is off by default: manual rates only, nothing fetched', async () => {
    const status = (await api().get('/api/v1/exchange-rates/feed').set(bearer(owner)).expect(200)).body.data;
    assert.equal(status.provider, 'manual');
    const run = (await api().post('/api/v1/exchange-rates/feed/run').set(bearer(owner)).expect(200)).body.data;
    assert.equal(run.outcome, 'off');
    assert.equal(calls, 0);
  });

  test('stores today\'s rates against the base currency, dated in the company\'s time zone', async () => {
    await switchOn().expect(200);
    const now = new Date('2031-11-03T22:30:00Z'); // 00:30 on 4 November in Lusaka (UTC+2)
    const run = await fetchRates({ now });
    assert.equal(run.outcome, 'stored');
    assert.equal(run.stored, 2);
    assert.equal(new Date(run.effectiveDate!).toISOString().slice(0, 10), '2031-11-04');
    const usd = (await rates('USD')).find((r) => r.source === 'feed')!;
    assert.equal(usd.baseCurrencyId, ids.USD);
    assert.equal(usd.quoteCurrencyId, ids.ZMW);
    assert.equal(Math.round(usd.rate * 100) / 100, 26.5);
    assert.equal(String(usd.effectiveDate).slice(0, 10), '2031-11-04');
    // Conversion uses it: 10 USD on 4 November is 265 ZMW.
    const converted = (await api().get('/api/v1/exchange-rates/convert').query({ fromCurrencyId: ids.USD, toCurrencyId: ids.ZMW, amountMinor: 1000, date: '2031-11-04' }).set(bearer(owner)).expect(200)).body.data;
    assert.equal(converted.resultMinor, 26500);
    // A second run the same day updates the feed's rate instead of adding another row.
    answer.USD = 1 / 26.6;
    await fetchRates({ now });
    const again = (await rates('USD')).filter((r) => r.source === 'feed');
    assert.equal(again.length, 1);
    assert.equal(Math.round(again[0]!.rate * 100) / 100, 26.6);
  });

  test('a rate entered by hand wins: the feed keeps it, and a manual rate replaces the feed\'s', async () => {
    await switchOn().expect(200);
    const now = new Date('2031-11-05T08:00:00Z');
    // Typed in before the fetch: kept.
    await api().post('/api/v1/exchange-rates').set(bearer(owner)).send({ baseCurrencyId: ids.USD, quoteCurrencyId: ids.ZMW, rate: 27, effectiveDate: '2031-11-05', source: 'bank' }).expect(201);
    const run = await fetchRates({ now });
    assert.equal(run.keptManual, 1);
    assert.equal(run.stored, 1);
    const day = (await rates('USD')).filter((r) => String(r.effectiveDate).startsWith('2031-11-05'));
    assert.deepEqual(day.map((r) => [r.source, r.rate]), [['bank', 27]]);
    // Typed in after the fetch: the feed's TZS rate for that day is replaced.
    await api().post('/api/v1/exchange-rates').set(bearer(owner)).send({ baseCurrencyId: ids.ZMW, quoteCurrencyId: ids.TZS, rate: 103, effectiveDate: '2031-11-05', source: 'manual' }).expect(201);
    const tzs = (await rates('TZS')).filter((r) => String(r.effectiveDate).startsWith('2031-11-05'));
    assert.deepEqual(tzs.map((r) => [r.source, r.rate]), [['manual', 103]]);
  });

  test('a failed fetch keeps earlier rates and says why; a missing key or currency is reported', async () => {
    await switchOn().expect(200);
    await fetchRates({ now: new Date('2031-11-06T08:00:00Z') });
    fail = new Error('Open Exchange Rates answered 429: too many requests');
    const run = await fetchRates({ now: new Date('2031-11-07T08:00:00Z') });
    assert.equal(run.outcome, 'failed');
    assert.match(run.error!, /429/);
    assert.equal((await rates('USD')).filter((r) => r.source === 'feed').length, 1, 'the 6 November rate is still there');
    const status = (await api().get('/api/v1/exchange-rates/feed').set(bearer(owner)).expect(200)).body.data;
    assert.equal(status.runs[0].outcome, 'failed');
    fail = null;
    delete answer.TZS;
    const partial = await fetchRates({ now: new Date('2031-11-08T08:00:00Z') });
    assert.deepEqual(partial.missing, ['TZS']);
    env.RATE_FEED_API_KEY = undefined;
    const noKey = await fetchRates({ now: new Date('2031-11-09T08:00:00Z') });
    assert.equal(noKey.outcome, 'failed');
    assert.match(noKey.error!, /RATE_FEED_API_KEY/);
  });

  test('the API key never leaves the server, settings are checked, and only allowed roles act', async () => {
    const status = (await switchOn({ provider: 'openexchangerates', currencyIds: [ids.USD], fetchAt: '06:30' }).expect(200)).body.data;
    assert.equal(status.keyConfigured, true);
    assert.ok(!JSON.stringify(status).includes('test-key'));
    assert.equal(status.fetchAt, '06:30');
    await switchOn({ provider: 'nosuchprovider' }).expect(422);
    await switchOn({ fetchAt: '25:00' }).expect(422);
    await switchOn({ currencyIds: ['0123456789abcdef01234567'] }).expect(422);
    // Only USD was chosen, so only USD is fetched.
    const run = await fetchRates({ now: new Date('2031-11-10T08:00:00Z') });
    assert.equal(run.stored, 1);
    const viewer = await userWithRole(owner, 'viewer');
    await api().get('/api/v1/exchange-rates/feed').set(bearer(viewer)).expect(200);
    await api().put('/api/v1/exchange-rates/feed').set(bearer(viewer)).send({ provider: 'manual' }).expect(403);
    await api().post('/api/v1/exchange-rates/feed/run').set(bearer(viewer)).expect(403);
  });

  test('the hourly job fetches once a day after the fetch time, and retries after a failure', async () => {
    assert.equal((await fetchIsDue(new Date('2031-11-11T08:00:00Z'))).due, false, 'off while manual');
    await switchOn({ provider: 'openexchangerates', fetchAt: '06:00' }).expect(200);
    // Lusaka is UTC+2: 03:30 UTC is 05:30 there, before the fetch time.
    assert.equal((await fetchIsDue(new Date('2031-11-11T03:30:00Z'))).due, false);
    assert.equal((await fetchIsDue(new Date('2031-11-11T04:05:00Z'))).due, true, '06:05 in Lusaka');
    fail = new Error('timeout');
    await fetchRates({ now: new Date('2031-11-11T04:05:00Z') });
    assert.equal((await fetchIsDue(new Date('2031-11-11T05:05:00Z'))).due, true, 'a failed fetch is tried again the next hour');
    fail = null;
    await fetchRates({ now: new Date('2031-11-11T05:05:00Z') });
    assert.equal((await fetchIsDue(new Date('2031-11-11T06:05:00Z'))).due, false, 'once stored, done for the day');
    assert.equal((await fetchIsDue(new Date('2031-11-12T04:05:00Z'))).due, true, 'due again the next day');
  });

  test('the company day follows the time zone, not UTC', () => {
    assert.equal(companyDay(new Date('2031-11-03T22:30:00Z'), 'Africa/Lusaka').toISOString().slice(0, 10), '2031-11-04');
    assert.equal(companyDay(new Date('2031-11-03T22:30:00Z'), 'UTC').toISOString().slice(0, 10), '2031-11-03');
    assert.equal(companyDay(new Date('2031-11-04T03:00:00Z'), 'America/New_York').toISOString().slice(0, 10), '2031-11-03');
  });
});
