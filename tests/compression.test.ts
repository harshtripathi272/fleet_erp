import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import express from 'express';
import request from 'supertest';
import { compressJson } from '../src/middleware/compressJson.js';
import { api, bearer, loadSample, signUp, startDatabase, stopDatabase, type Session } from './helpers.js';

let owner: Session;
before(async () => {
  await startDatabase();
  owner = await signUp('Owner');
  await loadSample(owner, 'full'); // with trips, so the sync is as big as a real desk's
});
after(stopDatabase);

test('JSON answers go brotli-compressed to browsers that accept it', async () => {
  const plain = await api().get('/api/v1/operations/sync').set(bearer(owner)).set('Accept-Encoding', 'identity').expect(200);
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.match(plain.headers.vary!, /Accept-Encoding/);

  const br = await api().get('/api/v1/operations/sync').set(bearer(owner)).set('Accept-Encoding', 'gzip, deflate, br').expect(200);
  assert.equal(br.headers['content-encoding'], 'br');
  assert.match(br.headers['content-type']!, /application\/json/);
  assert.equal(br.headers['cache-control'], 'no-store', 'still never cached');
  const unpacked = Buffer.byteLength(JSON.stringify(plain.body));
  const sent = Number(br.headers['content-length']);
  assert.ok(sent < unpacked / 4, `${sent} bytes sent for ${unpacked}`);
});

test('gzip when that is all the browser takes, and the same data once unpacked', async () => {
  const plain = await api().get('/api/v1/places').query({ limit: 100 }).set(bearer(owner)).set('Accept-Encoding', 'identity').expect(200);
  const gz = await api().get('/api/v1/places').query({ limit: 100 }).set(bearer(owner)).set('Accept-Encoding', 'gzip').expect(200);
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.ok(Number(gz.headers['content-length']) < Buffer.byteLength(JSON.stringify(plain.body)));
  assert.deepEqual(gz.body, plain.body);
});

test('sign-in answers are never compressed, however big: they carry tokens', async () => {
  const app = express();
  const big = { data: Array.from({ length: 200 }, (_, i) => ({ token: `t${i}`, email: 'someone@example.test' })) };
  app.use('/api', compressJson);
  app.get('/api/v1/auth/me', (_req, res) => res.json(big));
  app.get('/api/v1/places', (_req, res) => res.json(big));
  const auth = await request(app).get('/api/v1/auth/me').set('Accept-Encoding', 'br').expect(200);
  assert.equal(auth.headers['content-encoding'], undefined);
  const other = await request(app).get('/api/v1/places').set('Accept-Encoding', 'br').expect(200);
  assert.equal(other.headers['content-encoding'], 'br', 'the same answer elsewhere is compressed');
});

test('small answers and errors stay as they are', async () => {
  const health = await api().get('/api/v1/health').set('Accept-Encoding', 'br').expect(200);
  assert.equal(health.headers['content-encoding'], undefined);
  const missing = await api().get('/api/missing').set('Accept-Encoding', 'br').expect(404);
  assert.equal(missing.headers['content-encoding'], undefined);
  assert.equal(missing.body.error.code, 'NOT_FOUND');
});
