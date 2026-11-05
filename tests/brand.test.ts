import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { jpegSize } from '../src/modules/operations/pdf.js';
import { api, bearer, loadSample, signUp, startDatabase, stopDatabase, userWithRole, type Session } from './helpers.js';

/** White-label (#71): each company's own name, logo and watermark, everywhere. */
let owner: Session;
before(async () => {
  await startDatabase();
  owner = await signUp('Owner');
  await loadSample(owner, 'full');
});
after(stopDatabase);

/** A small JPEG header: start, a baseline frame of 120 × 40 pixels in colour, end. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x28, 0x00, 0x78, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);
const bytes = (path: string, who?: Session) => {
  const req = api().get(path);
  if (who) req.set(bearer(who));
  return req.buffer(true).parse((res, done) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => done(null, Buffer.concat(c))); });
};
const company = async () => (await api().get('/api/v1/company').set(bearer(owner)).expect(200)).body.data;
const saveBrand = async (change: Record<string, unknown>) => api().put('/api/v1/company').set(bearer(owner)).send({ ...change, version: (await company()).version });

describe('white-label', () => {
  test('the brand is public and starts from the company name, never another company', async () => {
    const brand = (await api().get('/api/v1/brand').expect(200)).body.data;
    assert.equal(brand.productName, (await company()).tradingName);
    assert.equal(brand.logo, null);
  });

  test("a company's product name, colour and sender name reach the brand and its e-mails", async () => {
    await saveBrand({ brand: { productName: 'Acme Haulage', accent: '#7a2e1d', emailSenderName: 'Acme Dispatch' } }).then((r) => assert.equal(r.status, 200, JSON.stringify(r.body)));
    const brand = (await api().get('/api/v1/brand').expect(200)).body.data;
    assert.deepEqual([brand.productName, brand.accent], ['Acme Haulage', '#7a2e1d']);
    const viewer = await userWithRole(owner, 'viewer');
    await api().post('/api/v1/auth/forgot-password').send({ email: viewer.email }).expect(200);
    const mail = (await api().get('/api/v1/meta/outbox').set(bearer(owner)).expect(200)).body.data as { subject: string }[];
    assert.ok(mail.some((m) => m.subject === 'Reset your Acme Haulage password'), JSON.stringify(mail.map((m) => m.subject)));
    // Saving one brand setting keeps the others.
    await saveBrand({ brand: { shortName: 'Acme' } }).then((r) => assert.equal(r.status, 200));
    assert.equal((await api().get('/api/v1/brand').expect(200)).body.data.productName, 'Acme Haulage');
  });

  test('the logo is served without a session; other files stay private', async () => {
    const file = (await api().post('/api/v1/files').set(bearer(owner)).set('Content-Type', 'image/jpeg').set('X-File-Name', 'logo.jpg').send(JPEG).expect(201)).body.data;
    await saveBrand({ brand: { logoFileId: file.id, logoPdfFileId: file.id } }).then((r) => assert.equal(r.status, 200, JSON.stringify(r.body)));
    const brand = (await api().get('/api/v1/brand').expect(200)).body.data;
    assert.match(brand.logo, /^\/api\/v1\/brand\/logo\?v=/);
    const logo = await bytes('/api/v1/brand/logo').expect(200);
    assert.equal(logo.headers['content-type'], 'image/jpeg');
    assert.ok((logo.body as Buffer).equals(JPEG));
    await api().get('/api/v1/brand/icon').expect(404);
    await api().get(`/api/v1/files/${file.id}`).expect(401);
  });

  test('the trip sheet carries the logo and the watermark the company chose', async () => {
    assert.deepEqual(jpegSize(JPEG), { width: 120, height: 40, components: 3 });
    await saveBrand({ watermark: { mode: 'text', text: 'ACME CONFIDENTIAL', opacity: 0.1, tripSheet: true } }).then((r) => assert.equal(r.status, 200, JSON.stringify(r.body)));
    const [trip] = (await api().get('/api/v1/trips?limit=1').set(bearer(owner)).expect(200)).body.data;
    const pdf = (await bytes(`/api/v1/trips/${trip.id}/sheet.pdf`, owner).expect(200)).body.toString('latin1');
    assert.ok(pdf.includes('/Subtype /Image /Width 120 /Height 40'), 'the logo is embedded');
    assert.ok(pdf.includes('(ACME CONFIDENTIAL) Tj'), 'the watermark is drawn');
    assert.ok(pdf.includes('/ca 0.1'), 'at the chosen opacity');
    // Switched off for trip sheets, it is gone.
    await saveBrand({ watermark: { tripSheet: false } });
    const plain = (await bytes(`/api/v1/trips/${trip.id}/sheet.pdf`, owner).expect(200)).body.toString('latin1');
    assert.ok(!plain.includes('ACME CONFIDENTIAL'));
  });

  test('only someone who may change the company may change its brand', async () => {
    const viewer = await userWithRole(owner, 'viewer');
    await api().put('/api/v1/company').set(bearer(viewer)).send({ brand: { productName: 'Hijack' }, version: (await company()).version }).expect(403);
  });
});
