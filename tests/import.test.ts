import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { api, bearer, loadSample, signUp, startDatabase, stopDatabase, userWithRole, type Session } from './helpers.js';

/** Loading a master from a spreadsheet (#41). */
let owner: Session;
before(async () => {
  await startDatabase();
  owner = await signUp('Owner');
  await loadSample(owner);
});
after(stopDatabase);

const run = (master: string, rows: Record<string, string>[], dryRun: boolean, who = owner) =>
  api().post(`/api/v1/meta/import/${master}`).set(bearer(who)).send({ rows, dryRun });

describe('import from a spreadsheet', () => {
  test('the template lists the columns people fill in, labelled, with required ones marked', async () => {
    const res = await api().get('/api/v1/meta/import/vehicles/template').set(bearer(owner)).expect(200);
    assert.match(res.headers['content-type']!, /text\/csv/);
    const header = res.text.replace(/^﻿/, '').trim().split(',');
    assert.ok(header.includes('Registration number *'), header.join(' | '));
    assert.ok(header.includes('Make *'));
    assert.ok(header.includes('Ownership'));
    assert.ok(!header.some((h) => /custom|attachments|external/i.test(h)));
    const info = (await api().get('/api/v1/meta/import/vehicles').set(bearer(owner)).expect(200)).body.data;
    assert.equal(info.columns.find((c: { path: string }) => c.path === 'makeId').target, 'vehicle-makes');
  });

  test('a dry run finds every problem by row and column, and saves nothing', async () => {
    const rows: Record<string, string>[] = [
      { Code: 'IMP1', 'Registration number': 'IMP 1001', Make: 'scania', 'Vehicle type': 'PRIME', Ownership: 'Own', Year: '2019' },
      { Code: 'IMP2', 'Registration number': 'IMP 1002', Make: 'Nosuchmake', 'Vehicle type': 'PRIME' },
      { Code: 'IMP3', 'Registration number': 'IMP 1003', Make: 'Volvo', 'Vehicle type': 'PRIME', Ownership: 'borrowed' },
      { Code: 'IMP4', Make: 'Volvo', 'Vehicle type': 'PRIME' },
      { Code: 'IMP1', 'Registration number': 'IMP 1005', Make: 'Volvo', 'Vehicle type': 'PRIME' },
      { Code: 'T001', 'Registration number': 'ALC 4821', Make: 'Scania', 'Vehicle type': 'PRIME' },
    ];
    const res = (await run('vehicles', rows, true).expect(200)).body.data;
    const by = (n: number) => res.results.find((r: { row: number }) => r.row === n);
    assert.equal(by(2).status, 'ready');
    assert.match(by(3).problems[0].message, /No make "Nosuchmake"/);
    assert.match(by(4).problems[0].message, /isn't one of: own, hired, leased/);
    assert.equal(by(5).problems[0].column, 'Registration number');
    assert.match(by(6).problems[0].message, /appears twice/);
    assert.equal(by(7).status, 'exists', 'T001 is in the sample data');
    const list = (await api().get('/api/v1/vehicles').query({ search: 'IMP', status: 'all' }).set(bearer(owner)).expect(200)).body.data;
    assert.equal(list.length, 0, 'a dry run saves nothing');
  });

  test('a load creates only the good rows, through the normal create; a second load adds nothing', async () => {
    const rows: Record<string, string>[] = [
      { 'Code *': 'IMP10', 'Registration number *': 'IMP 2001', 'Make *': 'Scania', 'Vehicle type *': 'PRIME', Year: '2020', 'Odometer km': '123,456' },
      { 'Code *': 'IMP11', 'Registration number *': 'IMP 2002', 'Make *': 'Nosuchmake', 'Vehicle type *': 'PRIME' },
    ];
    const first = (await run('vehicles', rows, false).expect(200)).body.data;
    assert.deepEqual(first.summary, { ready: 0, exists: 0, invalid: 1, created: 1, failed: 0 });
    const created = first.results[0].id as string;
    const v = (await api().get(`/api/v1/vehicles/${created}`).set(bearer(owner)).expect(200)).body.data;
    assert.equal(v.odometerKm, 123456);
    const history = (await api().get(`/api/v1/vehicles/${created}/history`).set(bearer(owner)).expect(200)).body.data;
    assert.equal(history[0].action, 'create', 'audited like any create');
    const again = (await run('vehicles', rows.slice(0, 1), false).expect(200)).body.data;
    assert.equal(again.results[0].status, 'exists');
  });

  test('dates, yes/no, lists, choices and money read the way spreadsheets write them', async () => {
    // A date written day first, and a reference by code.
    const rate = (await run('exchange-rates', [{ 'Base currency': 'USD', 'Quote currency': 'ZMW', Rate: '26.9', 'Effective date': '04/11/2025', Source: 'Manual' }], false).expect(200)).body.data;
    assert.equal(rate.results[0].status, 'created', JSON.stringify(rate.results[0]));
    const stored = (await api().get(`/api/v1/exchange-rates/${rate.results[0].id}`).set(bearer(owner)).expect(200)).body.data;
    assert.equal(String(stored.effectiveDate).slice(0, 10), '2025-11-04'); // a year back, clear of the sample's rate for yesterday
    // Yes/no, a list of references separated by ";", and a choice in any case.
    const pm = (await run('payment-methods', [{ Code: 'IMP-MOMO', Name: 'Imported mobile money', Kind: 'MOBILE_MONEY', 'For cash': 'yes', 'For fuel': 'no', Currencies: 'ZMW; usd' }], false).expect(200)).body.data;
    assert.equal(pm.results[0].status, 'created', JSON.stringify(pm.results[0]));
    const method = (await api().get(`/api/v1/payment-methods/${pm.results[0].id}`).set(bearer(owner)).expect(200)).body.data;
    assert.deepEqual([method.forCash, method.forFuel, method.kind, method.currencyIds.length], [true, false, 'mobile_money', 2]);
    // Money: "1.25 USD" becomes 125 cents of USD; a bad amount is reported.
    const product = (await api().get('/api/v1/products').query({ limit: 1 }).set(bearer(owner)).expect(200)).body.data[0];
    const priced = (await run('products', [
      { Code: 'IMP-OIL', Name: 'Imported oil', Group: product.groupId, Unit: product.unitId, 'Shortage price per unit': '1.25 USD' },
      { Code: 'IMP-OIL2', Name: 'Imported oil 2', Group: product.groupId, Unit: product.unitId, 'Shortage price per unit': 'lots' },
    ], true).expect(200)).body.data;
    assert.equal(priced.results[0].status, 'ready', JSON.stringify(priced.results[0]));
    assert.match(priced.results[1].problems[0].message, /not an amount/);
  });

  test('rights: create on that master; masters with their own flow are refused', async () => {
    const viewer = await userWithRole(owner, 'viewer');
    await run('vehicles', [{ Code: 'X' }], true, viewer).expect(403);
    await api().get('/api/v1/meta/import/vehicles/template').set(bearer(viewer)).expect(403);
    await run('users', [{ Name: 'X' }], true).expect(409);
    await run('nosuchmaster', [{ Code: 'X' }], true).expect(404);
    await api().post('/api/v1/meta/import/vehicles').set(bearer(owner)).send({ rows: [], dryRun: true }).expect(422);
  });
});
