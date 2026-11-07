/**
 * A year of data, timed (#105). `npx tsx scripts/perf-year.ts [--seed] [--trips 50000] [--trucks 500]` against the
 * database in MONGODB_URI (use a database of its own: --seed empties it). With --seed it loads the full sample, then
 * copies its trucks, trailers and drivers up to --trucks, and its trips (with their loads, requests, expenses and
 * activity) up to --trips, spread over the last year. Then it times what the desks and lists ask for, as the owner.
 */
import mongoose, { Types } from 'mongoose';
import request from 'supertest';
import { app } from '../src/app.js';
import { connectMongo, disconnectMongo, syncIndexes } from '../src/core/db/mongo.js';
import { ensureSystemRoles } from '../src/modules/roles/roles.service.js';

const arg = (name: string, fallback: number) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? Number(process.argv[i + 1]) : fallback; };
const TRIPS = arg('trips', 50_000);
const TRUCKS = arg('trucks', 500);
const EMAIL = 'perf.owner@example.test';
const PASSWORD = 'Passw0rd!perf';
const DAY = 86_400_000;
// A copy that keeps ObjectIds and dates as they are (structuredClone would turn ids into plain objects).
const { BSON } = mongoose.mongo;
const clone = <T extends object>(doc: T) => BSON.deserialize(BSON.serialize(doc)) as Record<string, any>;

await connectMongo();
const db = mongoose.connection.db!;
const api = request(app);

async function seed() {
  await db.dropDatabase();
  await syncIndexes();
  await ensureSystemRoles();
  await api.post('/api/v1/auth/register').send({ name: 'Perf Owner', email: EMAIL, password: PASSWORD }).expect(201);
  const token = (await api.post('/api/v1/auth/login').send({ email: EMAIL, password: PASSWORD })).body.data.accessToken as string;
  await api.post('/api/v1/meta/sample-data').set('Authorization', `Bearer ${token}`).send({ size: 'full' }).expect(201);

  // Trucks, trailers and drivers: copies of the sample's, each with its own plate, code and phone.
  const copy = async (name: string, target: number, change: (doc: Record<string, any>, n: number) => void) => {
    const col = db.collection(name);
    const base = await col.find().toArray();
    const docs: Record<string, any>[] = [];
    for (let n = base.length; n < target; n += 1) {
      const doc = clone(base[n % base.length]!);
      doc._id = new Types.ObjectId();
      change(doc, n);
      docs.push(doc);
    }
    if (docs.length) await col.insertMany(docs, { ordered: false });
    return (await col.find().project({ _id: 1 }).toArray()).map((d) => d._id);
  };
  const vehicles = await copy('vehicles', TRUCKS, (d, n) => { d.registrationNumber = `PRF ${String(n).padStart(4, '0')}`; d.registrationKey = `PRF${String(n).padStart(4, '0')}`; d.code = `VEH-P${n}`; delete d.vin; delete d.engineNumber; delete d.chassisNumber; });
  const trailers = await copy('trailers', TRUCKS, (d, n) => { d.registrationNumber = `PRT ${String(n).padStart(4, '0')}`; d.registrationKey = `PRT${String(n).padStart(4, '0')}`; d.code = `TRL-P${n}`; delete d.vin; delete d.chassisNumber; });
  const drivers = await copy('drivers', TRUCKS, (d, n) => { d.code = `DRV-P${n}`; d.phone = `+2609${String(70000000 + n)}`; delete d.whatsapp; delete d.nationalId; delete d.passport; delete d.taxIds; if (d.licence) d.licence.number = `PRF-DL-${n}`; delete d.assignedVehicleId; });

  // Trips and what hangs off them, copied from the sample's ended trips over the last year; a few stay open.
  const trips = db.collection('trips');
  const sample = await trips.find({ active: false, endedAt: { $exists: true } }).toArray();
  const children = ['consignments', 'fundrequests', 'expenses', 'activities', 'driverdocuments'];
  const related = Object.fromEntries(await Promise.all(children.map(async (c) => [c, await db.collection(c).find({ tripId: { $in: sample.map((t) => t._id) } }).toArray()])));
  const have = await trips.countDocuments();
  const BATCH = 2000;
  for (let start = have; start < TRIPS; start += BATCH) {
    const tripDocs: Record<string, any>[] = [];
    const kids: Record<string, Record<string, any>[]> = Object.fromEntries(children.map((c) => [c, []]));
    for (let n = start; n < Math.min(TRIPS, start + BATCH); n += 1) {
      const from = sample[n % sample.length]!;
      const t = clone(from);
      const id = new Types.ObjectId();
      const shift = Date.now() - (TRIPS - n) * (365 * DAY / TRIPS) - (t.endedAt?.getTime?.() ?? Date.now());
      const move = (v: unknown) => (v instanceof Date ? new Date(v.getTime() + shift) : v);
      for (const k of Object.keys(t)) t[k] = move(t[k]);
      Object.assign(t, { _id: id, number: `TRP-P${n}`, vehicleId: vehicles[n % vehicles.length], trailerId: trailers[n % trailers.length], driverId: drivers[n % drivers.length], active: false, createdAt: move(from.createdAt), updatedAt: move(from.updatedAt) });
      delete t.settlementId;
      tripDocs.push(t);
      for (const c of children) {
        for (const child of related[c]!.filter((x: Record<string, any>) => String(x.tripId) === String(from._id))) {
          const k = clone(child);
          for (const key of Object.keys(k)) k[key] = move(k[key]);
          Object.assign(k, { _id: new Types.ObjectId(), tripId: id, ...(k.number ? { number: `${String(k.number)}-P${n}` } : {}), ...(k.driverId ? { driverId: t.driverId } : {}), ...(k.vehicleId ? { vehicleId: t.vehicleId } : {}) });
          kids[c]!.push(k);
        }
      }
    }
    await trips.insertMany(tripDocs, { ordered: false });
    for (const c of children) if (kids[c]!.length) await db.collection(c).insertMany(kids[c]!, { ordered: false }).catch((e) => { if (e.code !== 11000) throw e; });
    process.stdout.write(`\r${Math.min(TRIPS, start + BATCH)} trips`);
  }
  process.stdout.write('\n');
}

if (process.argv.includes('--seed')) await seed();
const counts = Object.fromEntries(await Promise.all(['trips', 'consignments', 'fundrequests', 'expenses', 'activities', 'vehicles', 'drivers'].map(async (c) => [c, await db.collection(c).countDocuments()])));
console.log('records', JSON.stringify(counts));

const token = (await api.post('/api/v1/auth/login').send({ email: EMAIL, password: PASSWORD })).body.data.accessToken as string;
const calls = [
  '/api/v1/operations/sync', '/api/v1/dashboards/owner', '/api/v1/dashboards/finance',
  '/api/v1/trips?limit=50', '/api/v1/trips?limit=50&status=ended', '/api/v1/fund-requests?limit=50', '/api/v1/expenses?limit=50', '/api/v1/consignments?limit=50',
  '/api/v1/settlements?limit=50', '/api/v1/driver-accounts', '/api/v1/activity?limit=50', '/api/v1/messages/threads',
  '/api/v1/vehicles?limit=25', '/api/v1/drivers?limit=25&search=Mwansa', '/api/v1/vehicle-states', '/api/v1/meta/stats', '/api/v1/maintenance/services',
];
console.log('call'.padEnd(48), 'ms'.padStart(7), 'KB'.padStart(9), 'status');
for (const path of calls) {
  const runs: number[] = [];
  let size = 0;
  let status = 0;
  for (let i = 0; i < 3; i += 1) {
    const t0 = performance.now();
    const res = await api.get(path).set('Authorization', `Bearer ${token}`);
    runs.push(performance.now() - t0);
    size = (res.text ?? '').length;
    status = res.status;
  }
  console.log(path.padEnd(48), Math.round(Math.min(...runs)).toString().padStart(7), Math.round(size / 1024).toString().padStart(9), status);
}
await disconnectMongo();
process.exit(0);
