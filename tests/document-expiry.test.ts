// #105 (from #97's review): documents that expire remind someone. A company's document field with an expiry date
// and a compliance document each send "expiring" once inside the window and "expired" once after; renewing starts again.
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { after, before, beforeEach, describe, test } from 'node:test';
import { setFileStore, type FileStore } from '../src/core/storage/index.js';
import { ExpiryReminder, remindExpiringDocuments } from '../src/modules/compliance/expiryReminders.js';
import { api, bearer, find, loadSample, resetDatabase, signUp, startDatabase, stopDatabase, type Session } from './helpers.js';

const stored = new Map<string, Buffer>();
const memoryStore: FileStore = {
  async put(key, body) { stored.set(key, body); },
  async open(key) { const s = new PassThrough(); s.end(stored.get(key)); return s; },
  async remove(key) { stored.delete(key); },
};
const PDF = Buffer.from('%PDF-1.7\nA medical certificate');
const DAY = 86_400_000;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

let owner: Session;
const ids: Record<string, string> = {};
const ok = <T = any>(res: { status: number; body: any }, status = 200): T => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body.data as T;
};
const call = (method: 'get' | 'post' | 'patch', path: string, body?: object) => api()[method](`/api/v1${path}`).set(bearer(owner)).send(body);

async function certificate(driver: string, expiresOn: string) {
  const file = ok(await api().post('/api/v1/files').query({ entity: 'drivers', field: 'medicalCertificate' }).set(bearer(owner)).set('Content-Type', 'application/pdf').set('X-File-Name', 'medical.pdf').send(PDF), 201);
  const before = ok(await call('get', `/drivers/${driver}`));
  return ok(await call('patch', `/drivers/${driver}`, { custom: { ...(before.custom ?? {}), medicalCertificate: { fileId: file.id, expiresOn } }, version: before.version }));
}

before(async () => { await startDatabase(); setFileStore(memoryStore); });
after(stopDatabase);
beforeEach(async () => {
  await resetDatabase();
  owner = await signUp('Owner');
  await loadSample(owner);
  ids.d1 = (await find(owner, 'drivers', 'Joseph')).id;
  ids.d2 = (await find(owner, 'drivers', 'Martha')).id;
  ok(await call('post', '/field-definitions', { entity: 'drivers', key: 'medicalCertificate', label: 'Medical certificate', type: 'document', withExpiry: true }), 201);
});

describe('documents that expire', () => {
  test('a document field reminds once when due, once when expired, and again after renewal', async () => {
    await certificate(ids.d1!, inDays(10));
    await certificate(ids.d2!, inDays(200));
    await ExpiryReminder.deleteMany({});
    const first = await remindExpiringDocuments();
    const mine = async () => (await ExpiryReminder.find({ ref: new RegExp(`^drivers:${ids.d1}:`) }).lean()).map((r) => r.state);
    assert.deepEqual(await mine(), ['expiring'], 'due within 30 days; the other driver is not');
    assert.ok(first >= 1);
    assert.equal(await remindExpiringDocuments(), 0, 'a second run sends nothing again');

    await remindExpiringDocuments(new Date(Date.now() + 12 * DAY));
    assert.deepEqual((await mine()).sort(), ['expired', 'expiring'], 'once more when it lapses');

    await certificate(ids.d1!, inDays(20));
    await remindExpiringDocuments();
    assert.equal((await mine()).length, 3, 'a renewed certificate is reminded on its own date');
  });

  test('compliance documents remind the same way', async () => {
    const docs = ok<any[]>(await call('get', '/compliance-documents?limit=100&status=active'));
    const soonest = docs.filter((d) => d.expiryDate).sort((a, b) => String(a.expiryDate).localeCompare(String(b.expiryDate)))[0];
    assert.ok(soonest, 'the sample has compliance documents');
    await ExpiryReminder.deleteMany({});
    await remindExpiringDocuments(new Date(Date.parse(soonest.expiryDate) + DAY));
    const reminded = await ExpiryReminder.findOne({ ref: `compliance-documents:${soonest.id}` }).lean();
    assert.equal(reminded?.state, 'expired');
  });
});
