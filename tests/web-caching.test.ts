import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import request from 'supertest';

// A built web app in a folder of its own; WEB_DIR is read when the app loads, so the app is imported after.
const webDir = mkdtempSync(join(tmpdir(), 'fleet-web-'));
mkdirSync(join(webDir, 'assets'));
writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>Fleet</title>');
writeFileSync(join(webDir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
writeFileSync(join(webDir, 'assets', 'Trips-a1b2c3.js'), 'export {};');
// The build's compressed copies (web/vite.config.ts), for a file big enough to have them.
const script = `export const trips = ${JSON.stringify(Array.from({ length: 200 }, (_, i) => `trip ${i}`))};`;
writeFileSync(join(webDir, 'assets', 'index-d4e5f6.js'), script);
writeFileSync(join(webDir, 'assets', 'index-d4e5f6.js.br'), brotliCompressSync(script));
writeFileSync(join(webDir, 'assets', 'index-d4e5f6.js.gz'), gzipSync(script));
process.env.WEB_DIR = webDir;
const { app } = await import('../src/app.js');

test('hashed assets are kept for a year: a new build gives them new names', async () => {
  const r = await request(app).get('/assets/Trips-a1b2c3.js').expect(200);
  assert.match(r.headers['cache-control']!, /max-age=31536000/);
  assert.match(r.headers['cache-control']!, /immutable/);
});

test('scripts go compressed to browsers that accept it, brotli first, and plain to the rest', async () => {
  const br = await request(app).get('/assets/index-d4e5f6.js').set('Accept-Encoding', 'gzip, deflate, br').expect(200);
  assert.equal(br.headers['content-encoding'], 'br');
  assert.equal(Number(br.headers['content-length']), brotliCompressSync(script).length);
  assert.match(br.headers['content-type']!, /javascript/);
  assert.match(br.headers.vary!, /Accept-Encoding/);
  assert.match(br.headers['cache-control']!, /max-age=31536000, immutable/);

  const gzip = await request(app).get('/assets/index-d4e5f6.js').set('Accept-Encoding', 'gzip').expect(200);
  assert.equal(gzip.headers['content-encoding'], 'gzip');
  assert.equal(gzip.text, script);

  const plain = await request(app).get('/assets/index-d4e5f6.js').set('Accept-Encoding', 'identity').expect(200);
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.text, script);
  assert.match(plain.headers.vary!, /Accept-Encoding/);
});

test('an asset from an older build is a 404, not the page in its place', async () => {
  // The app reloads itself when a screen it asks for is gone after a deploy (web/src/App.tsx).
  const r = await request(app).get('/assets/Trips-old999.js').expect(404);
  assert.doesNotMatch(r.headers['content-type'] ?? '', /html/);
});

test('the page is checked with the server every time, however it is asked for, so a deploy is picked up at once', async () => {
  for (const path of ['/', '/index.html', '/trips/42']) {
    const r = await request(app).get(path).expect(200);
    assert.equal(r.headers['cache-control'], 'no-cache', path);
    assert.match(r.text, /<title>Fleet<\/title>/, path);
  }
});

test('other files beside the page are kept for an hour', async () => {
  const r = await request(app).get('/favicon.svg').expect(200);
  assert.equal(r.headers['cache-control'], 'public, max-age=3600');
});
