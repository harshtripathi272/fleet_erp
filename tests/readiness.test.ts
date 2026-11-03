import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { api, bearer, loadSample, resetDatabase, signUp, startDatabase, stopDatabase } from './helpers.js';

/** "Set up the company": what a new installation still needs before its first trip (#45). */
before(startDatabase);
after(stopDatabase);

describe('readiness for a first trip', () => {
  test('an empty installation lists everything a first trip needs, and the sample company is ready', async () => {
    await resetDatabase();
    const owner = await signUp('Owner');
    const empty = (await api().get('/api/v1/meta/readiness').set(bearer(owner)).expect(200)).body.data;
    assert.equal(empty.ready, false);
    for (const label of ['Company details', 'Places', 'Customers', 'Trucks', 'Drivers', 'Payment methods']) assert.ok(empty.missing.includes(label), label);
    assert.ok(!empty.missing.includes('Routes'), 'routes help, but are not required');
    const places = empty.checks.find((c: { key: string }) => c.key === 'places');
    assert.deepEqual([places.count, places.min, places.master], [0, 2, 'places']);

    await loadSample(owner);
    const full = (await api().get('/api/v1/meta/readiness').set(bearer(owner)).expect(200)).body.data;
    assert.equal(full.ready, true, JSON.stringify(full.missing));
    assert.ok(full.checks.find((c: { key: string }) => c.key === 'vehicles').count >= 1);
    await api().get('/api/v1/meta/readiness').expect(401);
  });
});
