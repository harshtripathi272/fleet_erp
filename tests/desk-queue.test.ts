// #92: the queue behind the desks' badges counts each request, not each trip.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// The web app's own code: loaded at run time, since the API's type-check doesn't cover the web app.
type AppData = Record<string, unknown>;
const web = '../web/src/domain/turn.js';
const { queueFor } = await import(web) as { queueFor: (data: AppData, desk: string) => Array<{ key: string; move: string }> };

const request = (id: string, tripId: string, status: string, kind = 'fuel') => ({ id, no: id, tripId, status, kind, amount: 100, currency: 'USD', trail: [], createdAt: '2026-11-05T08:00:00.000Z', mayDecide: true });
const trip = (id: string, dispatchedAt?: string) => ({ id, no: id, truckId: 'v1', driverId: 'd1', stops: [{ placeId: 'p1', kind: 'start' }, { placeId: 'p2', kind: 'load' }, { placeId: 'p3', kind: 'offload' }, { placeId: 'p3', kind: 'end' }], createdAt: '2026-11-05T07:00:00.000Z', dispatchedAt, active: true });
const appData = (trips: unknown[], requests: unknown[]) => ({
  trips, requests, docs: [], expenses: [], consignments: [], settlements: [], nominations: [], messages: [],
  drivers: [{ id: 'd1', name: 'Joseph Mwansa' }], trucks: [{ id: 'v1', plate: 'ALC 4821', fuelL: 100 }], places: [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }, { id: 'p3', name: 'C' }],
  trailers: [], routes: [], products: [], categories: [], customers: [], settings: { clockOffsetMs: 0 },
}) as AppData;
const keys = (data: AppData, desk: 'finance' | 'owner') => queueFor(data, desk).map((i) => i.key).sort();

describe('the Finance queue', () => {
  test('two requests waiting on a trip that has not left are two things to do', () => {
    assert.deepEqual(keys(appData([trip('t1')], [request('r1', 't1', 'pending'), request('r2', 't1', 'pending', 'cash')]), 'finance'), ['r1', 'r2']);
  });
  test('one to approve and one to pay on the same trip are both there, each with its move', () => {
    const items = queueFor(appData([trip('t1')], [request('r1', 't1', 'pending'), request('r2', 't1', 'approved', 'cash')]), 'finance');
    assert.deepEqual(items.map((i) => [i.key, i.move]).sort(), [['r1', 'approve'], ['r2', 'issue']]);
  });
  test('a request on a trip on the road still counts, once', () => {
    assert.deepEqual(keys(appData([trip('t1', '2026-11-05T09:00:00.000Z')], [request('r1', 't1', 'pending')]), 'finance'), ['r1']);
  });
  test('requests on two trips add up', () => {
    assert.deepEqual(keys(appData([trip('t1'), trip('t2')], [request('r1', 't1', 'pending'), request('r2', 't2', 'pending')]), 'finance'), ['r1', 'r2']);
  });
});

describe('the owner queue', () => {
  test('two requests at the owner\'s level on a trip that has not left are two things to do', () => {
    assert.deepEqual(keys(appData([trip('t1')], [request('r1', 't1', 'owner'), request('r2', 't1', 'owner', 'cash')]), 'owner'), ['r1', 'r2']);
  });
});
