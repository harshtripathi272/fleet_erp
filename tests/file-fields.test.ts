// #97: file, image and document fields on any master. A field holds { fileId, name, mime, size }, never the bytes;
// a file on a record opens for whoever can read the record; uploads follow the field's kinds and size.
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { after, before, beforeEach, describe, test } from 'node:test';
import { setFileStore, type FileStore } from '../src/core/storage/index.js';
import { renderPdf } from '../src/modules/operations/pdf.js';
import { api, bearer, find, loadSample, resetDatabase, signUp, startDatabase, stopDatabase, userWithRole, type Session } from './helpers.js';

const stored = new Map<string, Buffer>();
const memoryStore: FileStore = {
  async put(key, body) { stored.set(key, body); },
  async open(key) {
    const body = stored.get(key);
    if (!body) throw new Error('missing');
    const stream = new PassThrough();
    stream.end(body);
    return stream;
  },
  async remove(key) { stored.delete(key); },
};

// A JPEG with a start-of-frame marker (40 × 30 pixels), a PDF, and a Word file (a zip with a word/ folder).
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x1e, 0x00, 0x28, 0x03]), Buffer.alloc(12), Buffer.from([0xff, 0xd9])]);
const PDF = Buffer.from('%PDF-1.7\nA medical certificate');
const PDF2 = Buffer.from('%PDF-1.7\nThe renewed medical certificate');
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('....word/document.xml....')]);

let owner: Session, ops: Session, fin: Session;
const ids: Record<string, string> = {};
const as = (s: { token: string }) => ({
  get: (path: string, query: Record<string, unknown> = {}) => api().get(`/api/v1${path}`).query(query).set(bearer(s)),
  post: (path: string, body: unknown = {}) => api().post(`/api/v1${path}`).set(bearer(s)).send(body as object),
  put: (path: string, body: unknown) => api().put(`/api/v1${path}`).set(bearer(s)).send(body as object),
  patch: (path: string, body: unknown) => api().patch(`/api/v1${path}`).set(bearer(s)).send(body as object),
  upload: (body: Buffer, name: string, query: Record<string, string> = {}) => api().post('/api/v1/files').query(query).set(bearer(s)).set('Content-Type', 'application/octet-stream').set('X-File-Name', encodeURIComponent(name)).send(body),
});
const ok = <T = any>(res: { status: number; body: any }, status = 200): T => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body.data as T;
};
const forField = { entity: 'drivers', field: 'medicalCertificate' };

/** A user whose only permission is to read the given masters. */
async function reader(resources: string[], key: string) {
  ok(await as(owner).post('/roles', { key, name: `Reads ${resources.join(', ')}`, permissions: resources.map((resource) => ({ resource, actions: ['read'] })) }), 201);
  return userWithRole(owner, key, `Reader of ${resources.join(', ')}`);
}

async function driverSignsIn(driver: string, phone: string) {
  ok(await as(owner).put(`/users/driver-access/${driver}`, { phone, password: 'Truck2026' }));
  return { token: ok<{ accessToken: string }>(await api().post('/api/v1/auth/login').send({ phone, password: 'Truck2026' })).accessToken };
}

const medical = () => as(owner).post('/field-definitions', { entity: 'drivers', key: 'medicalCertificate', label: 'Medical certificate', type: 'document', withExpiry: true, maxSizeMb: 2 });
const attach = async (s: Session, driver: string, value: unknown) => {
  const before = ok(await as(s).get(`/drivers/${driver}`));
  return as(s).patch(`/drivers/${driver}`, { custom: { ...(before.custom ?? {}), medicalCertificate: value }, version: before.version });
};

before(async () => { await startDatabase(); setFileStore(memoryStore); });
after(stopDatabase);
beforeEach(async () => {
  await resetDatabase();
  stored.clear();
  owner = await signUp('Owner');
  await loadSample(owner);
  ops = await userWithRole(owner, 'operations', 'Olivia Ops');
  fin = await userWithRole(owner, 'finance', 'Felix Finance');
  ids.d1 = (await find(owner, 'drivers', 'Joseph')).id;
  ids.d2 = (await find(owner, 'drivers', 'Martha')).id;
});

describe('file field types', () => {
  test('image, document and files fields, each with only its own options', async () => {
    const field = ok(await medical(), 201);
    assert.equal(field.type, 'document');
    ok(await as(owner).post('/field-definitions', { entity: 'drivers', key: 'photo', label: 'Photo', type: 'image' }), 201);
    ok(await as(owner).post('/field-definitions', { entity: 'vehicles', key: 'permits', label: 'Permits', type: 'files', maxFiles: 3, accept: ['pdf', 'word'] }), 201);

    const refused = async (body: object) => assert.equal((await as(owner).post('/field-definitions', { entity: 'drivers', label: 'X', ...body })).status, 422, JSON.stringify(body));
    await refused({ key: 'x1', type: 'document', maxFiles: 2 });
    await refused({ key: 'x2', type: 'image', accept: ['word'] });
    await refused({ key: 'x3', type: 'files', withExpiry: true });
    await refused({ key: 'x4', type: 'text', maxSizeMb: 2 });
    await refused({ key: 'x5', type: 'document', maxSizeMb: 99 });

    const described = (ok<any[]>(await as(ops).get('/meta/masters'))).find((m) => m.key === 'vehicles').customFields.find((f: any) => f.key === 'permits');
    assert.deepEqual([described.accept, described.maxFiles], [['pdf', 'word'], 3], 'the form knows what the field takes');
  });
});

describe('uploading for a field', () => {
  test('the field decides the kinds and size; the bytes decide the kind', async () => {
    ok(await medical(), 201);
    const word = await as(ops).upload(DOCX, 'certificate.pdf', forField);
    assert.equal(word.status, 422);
    assert.equal(word.body.error.message, "That's a Word file; this field takes PDFs and pictures.");
    const big = await as(ops).upload(Buffer.concat([PDF, Buffer.alloc(2.5 * 1048576)]), 'big.pdf', forField);
    assert.equal(big.status, 422);
    assert.match(big.body.error.message, /up to 2 MB/);
    ok(await as(ops).upload(PDF, 'medical.pdf', forField), 201);
    assert.equal((await as(fin).upload(PDF, 'medical.pdf', forField)).status, 403, 'Finance may not change drivers');
    assert.equal((await as(ops).upload(PDF, 'x.pdf', { entity: 'drivers', field: 'nope' })).status, 422);

    ok(await as(owner).post('/field-definitions', { entity: 'vehicles', key: 'permits', label: 'Permits', type: 'files', accept: ['pdf', 'word'] }), 201);
    const docx = ok(await as(ops).upload(DOCX, 'permit.docx', { entity: 'vehicles', field: 'permits' }), 201);
    assert.equal(docx.mime, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    const download = await as(ops).get(`/files/${docx.id}`);
    assert.match(String(download.headers['content-disposition']), /^attachment/, 'a Word file is always downloaded, never shown');
    assert.equal((await as(ops).upload(DOCX, 'permit.docx')).status, 422, 'without a field, only photos and PDFs');
  });
});

describe('a file on a record', () => {
  test('the record keeps the stored name and size; whoever reads drivers opens it; others do not', async () => {
    ok(await medical(), 201);
    const file = ok(await as(ops).upload(PDF, 'Joseph medical.pdf', forField), 201);
    const readsDrivers = await reader(['drivers'], 'driver-reader');
    const readsTrucks = await reader(['vehicles'], 'truck-reader');
    assert.equal((await as(readsDrivers).get(`/files/${file.id}`)).status, 404, 'on no record yet: only its uploader');

    const saved = ok(await attach(ops, ids.d1!, { fileId: file.id, name: 'renamed.exe', size: 1, expiresOn: '2027-03-31' }));
    assert.deepEqual(saved.custom.medicalCertificate, { fileId: file.id, name: 'Joseph medical.pdf', mime: 'application/pdf', size: PDF.length, expiresOn: '2027-03-31' });

    const opened = await as(readsDrivers).get(`/files/${file.id}`);
    assert.equal(opened.status, 200);
    assert.equal(opened.headers['content-type'], 'application/pdf');
    assert.equal((await as(readsTrucks).get(`/files/${file.id}`)).status, 404, 'cannot read drivers, cannot open their files');
    assert.equal((await as(fin).get(`/files/${file.id}`)).status, 200, 'Finance reads drivers');

    const list = ok<any[]>(await as(readsDrivers).get('/drivers', { search: 'Joseph' }));
    const value = list[0].custom.medicalCertificate;
    assert.deepEqual(Object.keys(value).sort(), ['expiresOn', 'fileId', 'mime', 'name', 'size'], 'the list holds the name and size, no bytes and no address');
  });

  test("someone else's file, or the wrong kind, is refused", async () => {
    ok(await medical(), 201);
    const other = await userWithRole(owner, 'operations', 'Other Ops');
    const theirs = ok(await as(other).upload(PDF, 'theirs.pdf', forField), 201);
    const res = await attach(ops, ids.d1!, { fileId: theirs.id });
    assert.equal(res.status, 422);
    assert.deepEqual(res.body.error.details.custom.medicalCertificate, ['The attached file was not found']);

    ok(await as(owner).post('/field-definitions', { entity: 'drivers', key: 'photo', label: 'Photo', type: 'image' }), 201);
    const pdf = ok(await as(ops).upload(PDF, 'not a photo.pdf', forField), 201);
    const before = ok(await as(ops).get(`/drivers/${ids.d1}`));
    const wrong = await as(ops).patch(`/drivers/${ids.d1}`, { custom: { photo: { fileId: pdf.id } }, version: before.version });
    assert.equal(wrong.status, 422);
    assert.deepEqual(wrong.body.error.details.custom.photo, ["That's a PDF; this field takes pictures."]);
  });

  test('a replaced file stays in the history and still opens from it', async () => {
    ok(await medical(), 201);
    const first = ok(await as(ops).upload(PDF, 'medical 2026.pdf', forField), 201);
    ok(await attach(ops, ids.d1!, { fileId: first.id }));
    const second = ok(await as(ops).upload(PDF2, 'medical 2027.pdf', forField), 201);
    const replaced = ok(await attach(ops, ids.d1!, { fileId: second.id, expiresOn: '2028-01-31' }));
    assert.equal(replaced.custom.medicalCertificate.name, 'medical 2027.pdf');

    const history = ok<any[]>(await as(fin).get(`/drivers/${ids.d1}/history`));
    const change = history.find((h) => h.changes.some((c: any) => c.path === 'custom.medicalCertificate' && c.from?.fileId === first.id)).changes.find((c: any) => c.path === 'custom.medicalCertificate');
    assert.deepEqual([change.from.name, change.to.name], ['medical 2026.pdf', 'medical 2027.pdf'], 'the history says which file it was and which it is');
    const readsDrivers = await reader(['drivers'], 'driver-reader');
    assert.equal((await as(readsDrivers).get(`/files/${first.id}`)).status, 200, 'the old file is kept, not deleted');
  });

  test("a driver opens their own record's file in the driver app, not another driver's", async () => {
    ok(await medical(), 201);
    const own = ok(await as(ops).upload(PDF, 'joseph.pdf', forField), 201);
    const others = ok(await as(ops).upload(PDF2, 'other.pdf', forField), 201);
    ok(await attach(ops, ids.d1!, { fileId: own.id }));
    ok(await attach(ops, ids.d2!, { fileId: others.id }));
    const joseph = await driverSignsIn(ids.d1!, '+260971234567');
    assert.equal((await as(joseph).get(`/files/${own.id}`)).status, 200);
    assert.equal((await as(joseph).get(`/files/${others.id}`)).status, 404);
  });
});

describe('a custom master with a files field', () => {
  test("its records hold files like a master's, opened by whoever reads its records", async () => {
    const master = ok(await as(owner).post('/custom-masters', {
      code: 'inspections', name: 'Inspections', titleField: 'reference',
      fields: [{ key: 'reference', label: 'Reference', type: 'text', required: true }, { key: 'photos', label: 'Photos', type: 'files', maxFiles: 2, accept: ['images'] }],
    }), 201);
    const photo = ok(await as(owner).upload(JPEG, 'tyres.jpg', { master: master.id, field: 'photos' }), 201);
    const refused = await as(owner).upload(PDF, 'report.pdf', { master: master.id, field: 'photos' });
    assert.equal(refused.body.error.message, "That's a PDF; this field takes pictures.");
    const record = ok(await as(owner).post(`/custom-masters/${master.id}/records`, { data: { reference: 'INS-1', photos: [{ fileId: photo.id }] } }), 201);
    assert.deepEqual(record.data.photos, [{ fileId: photo.id, name: 'tyres.jpg', mime: 'image/jpeg', size: JPEG.length }]);
    const tooMany = await as(owner).post(`/custom-masters/${master.id}/records`, { data: { reference: 'INS-2', photos: [{ fileId: photo.id }, { fileId: photo.id }] } });
    assert.equal(tooMany.status, 422, 'the same file twice');
    const readsRecords = await reader(['custom-records'], 'records-reader');
    assert.equal((await as(readsRecords).get(`/files/${photo.id}`)).status, 200);
  });
});

describe('placing a company field among the built-in ones', () => {
  test("its section, order and list column are the layout's; its name and rules are the field's", async () => {
    ok(await medical(), 201);
    ok(await as(owner).put('/meta/layouts/drivers', { sections: ['Health'], fields: [{ path: 'custom.medicalCertificate', section: 'Health', order: 5, column: true }] }));
    const drivers = (ok<any[]>(await as(ops).get('/meta/masters'))).find((m) => m.key === 'drivers');
    const field = drivers.customFields.find((f: any) => f.key === 'medicalCertificate');
    assert.deepEqual([field.section, field.layoutOrder, field.column], ['Health', 5, true]);
    assert.ok(drivers.columns.includes('custom.medicalCertificate'), 'a list column');
    const renamed = await as(owner).put('/meta/layouts/drivers', { fields: [{ path: 'custom.medicalCertificate', label: 'Medical' }] });
    assert.equal(renamed.status, 422);
    assert.equal((await as(owner).put('/meta/layouts/drivers', { fields: [{ path: 'custom.nothing', column: true }] })).status, 422);
  });
});

describe('import and printing', () => {
  test('file fields are left out of the import template with a note; other company fields are columns', async () => {
    ok(await medical(), 201);
    ok(await as(owner).post('/field-definitions', { entity: 'drivers', key: 'badgeNumber', label: 'Badge number', type: 'text' }), 201);
    const info = ok(await as(owner).get('/meta/import/drivers'));
    assert.ok(info.columns.some((c: any) => c.path === 'custom.badgeNumber'));
    assert.ok(!info.columns.some((c: any) => c.path === 'custom.medicalCertificate'));
    assert.deepEqual(info.leftOut, [{ label: 'Medical certificate', reason: 'Files are added on the record, not by import' }]);
    const template = await as(owner).get('/meta/import/drivers/template');
    assert.match(template.text, /Badge number,Medical certificate \(add on the record\)\r\n$/);
  });

  test('a picture prints as itself on a document', () => {
    const pdf = renderPdf([{ kind: 'title', text: 'Trip sheet' }, { kind: 'picture', label: 'Driver photo', jpeg: JPEG }]).toString('latin1');
    assert.match(pdf, /\/Im2 \d+ 0 R/);
    assert.match(pdf, /\/Width 40 \/Height 30 .*\/DCTDecode/);
    assert.match(pdf, /\(Driver photo\) Tj/);
  });
});

