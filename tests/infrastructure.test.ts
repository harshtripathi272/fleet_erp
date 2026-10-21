import assert from 'node:assert/strict';
import { test } from 'node:test';
import request from 'supertest';
import { app } from '../src/app.js';
import { envSchema } from '../src/config/env.js';
import { MemoryRateLimitStore, RedisRateLimitStore } from '../src/core/rateLimit/index.js';
import { clearMail, recentMail, sendMail } from '../src/core/mail/mailer.js';
import { checkStops, routeDistances } from '../src/modules/geography/geography.service.js';
import { placeholders, smsSegments } from '../src/modules/messaging/messaging.service.js';
import { renderSeries } from '../src/modules/organisation/organisation.service.js';
import { expiryState } from '../src/modules/drivers/drivers.service.js';

/** A stand-in for the node-redis client covering the commands the limiter uses. */
function fakeRedis() {
  const data = new Map<string, { value: number; expiresAt: number }>();
  const live = (key: string) => { const e = data.get(key); if (e && e.expiresAt <= Date.now()) data.delete(key); return data.get(key); };
  return {
    data,
    multi() {
      const ops: Array<() => unknown> = [];
      const chain = {
        set(key: string, value: string, opts: { PX: number; NX: boolean }) { ops.push(() => { if (opts.NX && live(key)) return null; data.set(key, { value: Number(value), expiresAt: Date.now() + opts.PX }); return 'OK'; }); return chain; },
        incr(key: string) { ops.push(() => { const e = live(key) ?? { value: 0, expiresAt: Infinity }; e.value += 1; data.set(key, e); return e.value; }); return chain; },
        pTTL(key: string) { ops.push(() => { const e = live(key); return e ? (e.expiresAt === Infinity ? -1 : e.expiresAt - Date.now()) : -2; }); return chain; },
        async exec() { return ops.map((op) => op()); },
      };
      return chain;
    },
    async del(key: string) { data.delete(key); return 1; },
  };
}

test('Redis rate-limit store counts per window and resets', async () => {
  const redis = fakeRedis();
  const store = new RedisRateLimitStore(redis as never);
  const results = [];
  for (let i = 0; i < 4; i += 1) results.push(await store.hit('k', 3, 60000));
  assert.deepEqual(results.map((r) => r.allowed), [true, true, true, false]);
  assert.equal(results[3]!.remaining, 0);
  assert.ok(results[0]!.resetMs > 59000);
  await store.reset('k');
  assert.equal((await store.hit('k', 3, 60000)).count, 1);
  assert.ok(redis.data.has('rl:k'));
});

test('memory rate-limit store expires windows', async () => {
  const store = new MemoryRateLimitStore();
  assert.equal((await store.hit('a', 1, 30)).allowed, true);
  assert.equal((await store.hit('a', 1, 30)).allowed, false);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal((await store.hit('a', 1, 30)).allowed, true);
});

test('production configuration refuses unsafe settings', () => {
  const prod = { NODE_ENV: 'production', SMTP_HOST: 'smtp.mandrillapp.com', JWT_SECRET: 'p'.repeat(40) };
  assert.equal(envSchema.safeParse(prod).success, true);
  assert.equal(envSchema.safeParse({ ...prod, JWT_SECRET: undefined }).success, false);
  assert.equal(envSchema.safeParse({ ...prod, EXPOSE_RESET_TOKEN: 'true' }).success, false);
  assert.equal(envSchema.safeParse({ ...prod, SMTP_HOST: undefined }).success, false);
  assert.equal(envSchema.safeParse({ JWT_SECRET: 'short' }).success, false);
  assert.equal(envSchema.safeParse({ MONGODB_URI: 'http://x' }).success, false);
  assert.equal(envSchema.safeParse({ REDIS_URL: 'mongodb://x' }).success, false);
});

test('readiness reports an unavailable database with 503', async () => {
  const r = await request(app).get('/api/v1/health/ready').expect(503);
  assert.equal(r.body.error.code, 'SERVICE_UNAVAILABLE');
  assert.equal(r.body.error.details.mongo, 'disconnected');
});

test('security headers are sent and the console is served', async () => {
  const r = await request(app).get('/api/v1/health').expect(200);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.match(r.headers['content-security-policy']!, /default-src 'self'/);
  assert.equal(r.headers['x-powered-by'], undefined);
  const page = await request(app).get('/console/').expect(200);
  assert.match(page.text, /Fleet ERP API Console/);
  await request(app).get('/console/app.js').expect(200).expect('Content-Type', /javascript/);
});

test('without SMTP, mail is logged and kept in the development outbox', async () => {
  clearMail();
  assert.equal(await sendMail({ to: 'a@example.test', subject: 'Hi', text: 'Body' }), false);
  assert.equal(recentMail()[0]!.subject, 'Hi');
});

test('pure rules: route distances, numbering, placeholders, SMS segments, expiry', () => {
  const stops = [
    { placeId: 'a', kind: 'start', legKm: 0 }, { placeId: 'b', kind: 'load', legKm: 100 },
    { placeId: 'c', kind: 'via', legKm: 50 }, { placeId: 'd', kind: 'offload', legKm: 30 }, { placeId: 'a', kind: 'end', legKm: 120 },
  ];
  checkStops(stops);
  assert.deepEqual({ ...routeDistances(stops), stops: undefined }, { stops: undefined, totalKm: 300, loadedKm: 80, emptyKm: 220 });
  assert.throws(() => checkStops([{ placeId: 'a', kind: 'start', legKm: 0 }, { placeId: 'b', kind: 'end', legKm: 1 }]));
  assert.equal(renderSeries({ pattern: '{PREFIX}/{YY}/{SEQ}', prefix: 'TRIP', padding: 4 }, 7, '', new Date('2026-05-01T00:00:00Z')), 'TRIP/26/0007');
  assert.equal(renderSeries({ pattern: '{BR}-{YYYY}{MM}-{SEQ}', padding: 3 }, 12, 'NDL', new Date('2026-11-01T00:00:00Z')), 'NDL-202611-012');
  assert.deepEqual(placeholders('Hi {{ driver.name }} {{trip.number}}').names, ['driver.name', 'trip.number']);
  assert.ok(placeholders('{{bad}}').problems.length);
  assert.ok(placeholders('{{driver.name}').problems.length);
  assert.deepEqual(smsSegments('a'.repeat(160)), { encoding: 'GSM-7', characters: 160, segments: 1 });
  assert.equal(smsSegments('a'.repeat(161)).segments, 2);
  assert.equal(smsSegments('ü'.repeat(70)).encoding, 'GSM-7');
  assert.deepEqual(smsSegments('Ś'.repeat(71)), { encoding: 'UCS-2', characters: 71, segments: 2 });
  assert.equal(expiryState(null).state, 'missing');
  assert.equal(expiryState(new Date(Date.now() - 86400000)).state, 'expired');
  assert.equal(expiryState(new Date(Date.now() + 5 * 86400000)).state, 'expiring');
  assert.equal(expiryState(new Date(Date.now() + 90 * 86400000)).state, 'valid');
});
