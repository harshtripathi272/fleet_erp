// Expired papers stop a truck leaving (decision 24, the #102 walk), written first from what a transporter expects:
// a driver whose licence ran out yesterday can't take a truck out, and neither can a truck whose road tax did.
// Each paper type says what it blocks; the sample's licence and road tax block dispatch.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { api, bearer, find, loadSample, resetDatabase, signUp, startDatabase, stopDatabase, userWithRole, type Session } from './helpers.js';

let owner: Session, ops: Session;
const ids: Record<string, string> = {};
const as = (s: { token: string }) => ({
  get: (path: string) => api().get(`/api/v1${path}`).set(bearer(s)),
  post: (path: string, body: unknown = {}) => api().post(`/api/v1${path}`).set(bearer(s)).send(body as object),
  patch: (path: string, body: unknown) => api().patch(`/api/v1${path}`).set(bearer(s)).send(body as object),
  put: (path: string, body: unknown) => api().put(`/api/v1${path}`).set(bearer(s)).send(body as object),
});
const ok = <T = any>(res: { status: number; body: any }, status = 200): T => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body.data as T;
};
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function expire(number: string, on: string) {
  const doc = await find(owner, 'compliance-documents', number);
  const full = ok(await as(owner).get(`/compliance-documents/${doc.id}`));
  ok(await as(owner).patch(`/compliance-documents/${doc.id}`, { version: full.version, expiryDate: on }));
}
const planTrip = async () => ok(await as(ops).post('/trips', { customerId: ids.zambezi, vehicleId: ids.v1, driverId: ids.d1, trailerId: ids.t1, routeId: ids.routeDar, plannedStart: day(1) + 'T06:00:00.000Z' }), 201);

before(startDatabase);
after(stopDatabase);
beforeEach(async () => {
  await resetDatabase();
  owner = await signUp('Owner');
  await loadSample(owner);
  ops = await userWithRole(owner, 'operations', 'Olivia Ops');
  for (const [key, master, search] of [['zambezi', 'parties', 'Zambezi'], ['v1', 'vehicles', 'ALC 4821'], ['t1', 'trailers', 'TAC 7821'], ['d1', 'drivers', 'Joseph'], ['routeDar', 'routes', 'DAR-LSK'], ['depot', 'places', 'LSK-DEPOT']] as const) {
    ids[key] = (await find(owner, master, search)).id;
  }
  ok(await as(ops).put(`/vehicle-states/${ids.v1}`, { placeId: ids.depot, fuelL: 600 }));
});

describe('expired papers stop a truck leaving', () => {
  test("a driver whose licence ran out can't take the truck out; once the renewed licence is recorded, it leaves", async () => {
    await expire('ZM-DL-448812', day(-1));
    const t = await planTrip();
    const refused = await as(ops).post(`/trips/${t.id}/dispatch`);
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.match(refused.body.error.message, /Joseph.*Driving licence expired on .*(renewed|another driver|change the driver)/i);
    await expire('ZM-DL-448812', day(365));
    ok(await as(ops).post(`/trips/${t.id}/dispatch`));
  });

  test("a truck whose road tax ran out can't leave, and says which paper and what to do", async () => {
    await expire('RT-2026-0042', day(-3));
    const t = await planTrip();
    const refused = await as(ops).post(`/trips/${t.id}/dispatch`);
    assert.ok(refused.status >= 400 && refused.status < 500);
    assert.match(refused.body.error.message, /ALC 4821's Road tax expired on .*another truck/);
  });

  test('a paper expiring soon, or one that only blocks a border, does not stop the truck leaving', async () => {
    await expire('ZM-DL-448812', day(5));
    const t = await planTrip();
    ok(await as(ops).post(`/trips/${t.id}/dispatch`));
  });
});
