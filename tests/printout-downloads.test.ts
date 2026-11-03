// #44: the trip sheet and the driver statement as PDF files from the desks and the driver app, the same files
// the e-mails attach (printouts.ts), under the same permissions as their screens.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { api, bearer, loadSample, signUp, startDatabase, stopDatabase, type Session } from './helpers.js';

let owner: Session;
const get = (s: { token: string }, path: string) => api().get(`/api/v1${path}`).set(bearer(s)).buffer(true).parse((res, done) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => done(null, Buffer.concat(chunks)));
});
const data = async (s: Session, path: string) => (await api().get(`/api/v1${path}`).set(bearer(s)).expect(200)).body.data;

/** A valid PDF file, as the PDF writer makes it, holding the given text. */
function assertPdf(res: { status: number; headers: Record<string, string>; body: Buffer }, holds: string) {
  assert.equal(res.status, 200, res.body.toString().slice(0, 200));
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.match(res.headers['content-disposition']!, /^inline; filename\*=UTF-8''.+\.pdf$/);
  const text = res.body.toString('latin1');
  assert.ok(text.startsWith('%PDF-') && text.trimEnd().endsWith('%%EOF'), 'a whole PDF');
  assert.ok(text.includes(holds), `holds ${holds}`);
}

async function driverSignsIn(driverId: string) {
  const driver = await data(owner, `/drivers/${driverId}`);
  await api().put(`/api/v1/users/driver-access/${driverId}`).set(bearer(owner)).send({ phone: driver.phone, password: 'Truck2026' }).expect(200);
  const res = await api().post('/api/v1/auth/login').send({ phone: driver.phone, password: 'Truck2026' }).expect(200);
  return { token: res.body.data.accessToken as string };
}

before(async () => {
  await startDatabase();
  owner = await signUp('Owner');
  await loadSample(owner, 'full'); // trips and posted settlements
});
after(stopDatabase);

describe('printouts to download', () => {
  test('the trip sheet as a PDF holding the trip number', async () => {
    const [trip] = await data(owner, '/trips?limit=1');
    assertPdf(await get(owner, `/trips/${trip.id}/sheet.pdf`), trip.number);
  });

  test('a settlement statement as a PDF holding the settlement number', async () => {
    const [settlement] = await data(owner, '/settlements?limit=1');
    assertPdf(await get(owner, `/settlements/${settlement.id}/statement.pdf`), settlement.number);
  });

  test("the driver app: the driver's own statements, nobody else's, and none of the office's printouts", async () => {
    const settlements: Array<{ id: string; number: string; driverId: string }> = await data(owner, '/settlements?limit=100');
    const mine = settlements[0]!;
    const theirs = settlements.find((s) => s.driverId !== mine.driverId);
    assert.ok(theirs, 'the sample has settlements for more than one driver');
    const driver = await driverSignsIn(mine.driverId);

    const home = await data(driver as Session, '/driver-app/home');
    assert.ok(home.account.settlements.some((s: { id: string }) => s.id === mine.id), 'the app lists the statement');
    assertPdf(await get(driver, `/driver-app/settlements/${mine.id}/statement.pdf`), mine.number);
    assert.equal((await get(driver, `/driver-app/settlements/${theirs.id}/statement.pdf`)).status, 404, "another driver's statement is not found");

    // A driver account has no office rights, so the desks' printouts are refused, as their screens are.
    const [trip] = await data(owner, '/trips?limit=1');
    assert.equal((await get(driver, `/trips/${trip.id}/sheet.pdf`)).status, 403);
    assert.equal((await get(driver, `/settlements/${mine.id}/statement.pdf`)).status, 403);
  });
});
