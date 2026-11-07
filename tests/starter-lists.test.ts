import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { api, bearer, resetDatabase, signUp, startDatabase, stopDatabase, userWithRole } from './helpers.js';
import { companyFileSchema } from '../src/modules/setup/companyFile.js';

/** "Just the usual lists" (#116): what every transport company uses, nothing made up, in the company's currency. */
before(startDatabase);
after(stopDatabase);

describe('the usual lists', () => {
  test('a new company gets payment methods, vehicle types and the rest, in its own currency, and nothing made up', async () => {
    await resetDatabase();
    const owner = await signUp('Owner');
    const kes = (await api().post('/api/v1/currencies').set(bearer(owner)).send({ code: 'KES', name: 'Kenyan shilling', symbol: 'KSh', minorUnits: 2 }).expect(201)).body.data;
    await api().put('/api/v1/company').set(bearer(owner)).send({ legalName: 'Rift Valley Haulage', baseCurrencyId: kes.id, timezone: 'Africa/Nairobi' }).expect(200);

    const before = (await api().get('/api/v1/meta/readiness').set(bearer(owner)).expect(200)).body.data;
    assert.equal(before.usualListsMissing, true);
    assert.ok(before.missing.includes('Payment methods') && before.missing.includes('Vehicle types'));

    const first = (await api().post('/api/v1/meta/starter-lists').set(bearer(owner)).send({}).expect(201)).body.data;
    assert.deepEqual(first.failed, []);
    assert.ok(first.created >= 40, `created ${first.created}`);

    const list = async (key: string) => (await api().get(`/api/v1/${key}`).query({ limit: 100 }).set(bearer(owner)).expect(200)).body.data as Record<string, any>[];
    const cash = (await list('payment-methods')).find((p) => p.code === 'CASH')!;
    assert.deepEqual(cash.currencyIds, [kes.id], 'payment methods take the company\'s currency');
    const advance = (await list('approval-policies')).find((p) => p.subject === 'cash_advance')!;
    assert.equal(advance.currencyId, kes.id);
    assert.ok((await list('vehicle-types')).some((t) => t.code === 'PRIME'));
    assert.ok((await list('vehicle-makes')).length >= 10, 'a truck needs a make');
    assert.ok((await list('numbering-series')).some((s) => s.entity === 'trips'));
    assert.ok((await list('document-types')).every((d) => d.blocking === 'none' && !d.requiredForAll), 'no document blocks a first trip');
    for (const made of ['vehicles', 'drivers', 'parties', 'places']) assert.equal((await list(made)).length, 0, `no made-up ${made}`);

    const after = (await api().get('/api/v1/meta/readiness').set(bearer(owner)).expect(200)).body.data;
    assert.equal(after.usualListsMissing, false);
    assert.deepEqual(after.missing.sort(), ['Customers', 'Drivers', 'Places', 'Trucks'], 'only the company\'s own records are left');

    // Running again, or after the company changed one, adds nothing and changes nothing.
    await api().patch(`/api/v1/payment-methods/${cash.id}`).set(bearer(owner)).send({ name: 'Petty cash', version: cash.version }).expect(200);
    const again = (await api().post('/api/v1/meta/starter-lists').set(bearer(owner)).send({}).expect(201)).body.data;
    assert.equal(again.created, 0);
    assert.equal((await list('payment-methods')).find((p) => p.code === 'CASH')!.name, 'Petty cash');

    const driverDesk = await userWithRole(owner, 'operations');
    await api().post('/api/v1/meta/starter-lists').set(bearer(driverDesk)).send({}).expect(403);
  });

  test('a company file can ask for them, and it is the set-up\'s choice beside the samples', () => {
    const data = companyFileSchema.shape.data;
    assert.equal(data.parse({ sample: 'starter' }).sample, 'starter');
    assert.equal(data.parse(undefined).sample, 'none', 'an older file keeps starting empty');
  });
});
