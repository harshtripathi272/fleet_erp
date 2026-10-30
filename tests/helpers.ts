import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { app } from '../src/app.js';
import { connectMongo, syncIndexes } from '../src/core/db/mongo.js';
import { MemoryRateLimitStore, setRateLimitStore } from '../src/core/rateLimit/index.js';
import { ensureSystemRoles } from '../src/modules/roles/roles.service.js';

let mongo: MongoMemoryServer | null = null;

/** Standalone in-memory MongoDB: the same topology as the Docker Compose service. */
export async function startDatabase() {
  mongo = await MongoMemoryServer.create();
  await connectMongo(mongo.getUri('fleet_test'));
  await syncIndexes();
  await ensureSystemRoles();
  setRateLimitStore(new MemoryRateLimitStore());
}

export async function stopDatabase() {
  await mongoose.disconnect();
  await mongo?.stop();
}

export async function resetDatabase() {
  const db = mongoose.connection.db!;
  for (const c of await db.collections()) await c.deleteMany({});
  setRateLimitStore(new MemoryRateLimitStore());
  await ensureSystemRoles();
}

export const api = () => request(app);

export interface Session { token: string; refreshToken: string; userId: string; email: string; password: string; }
let counter = 0;
export const uniqueEmail = (tag = 'user') => `${tag}${++counter}.${process.pid}@example.test`;

/** Registers a user. On an empty database the first one becomes the owner. */
export async function signUp(name = 'Test User', password = 'Passw0rd!'): Promise<Session> {
  const email = uniqueEmail();
  const res = await api().post('/api/v1/auth/register').send({ name, email, password });
  if (res.status !== 201) throw new Error(`register failed ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.data.accessToken, refreshToken: res.body.data.refreshToken, userId: res.body.data.user.id, email, password };
}

export const bearer = (s: { token: string }) => ({ Authorization: `Bearer ${s.token}` });

/** Owner creates a user with the given system role and signs them in. */
export async function userWithRole(owner: Session, roleKey: string, name = `${roleKey} user`): Promise<Session> {
  const roles = await api().get('/api/v1/roles').query({ search: roleKey, limit: 100 }).set(bearer(owner));
  const role = roles.body.data.find((r: { key: string }) => r.key === roleKey);
  const email = uniqueEmail(roleKey);
  const password = 'Passw0rd!';
  const created = await api().post('/api/v1/users').set(bearer(owner)).send({ name, email, password, roleIds: [role.id] });
  if (created.status !== 201) throw new Error(`create user failed ${JSON.stringify(created.body)}`);
  const login = await api().post('/api/v1/auth/login').send({ email, password });
  return { token: login.body.data.accessToken, refreshToken: login.body.data.refreshToken, userId: created.body.data.user.id, email, password };
}

/** Loads the sample operation and returns a lookup of ids by master + code/title. */
export async function loadSample(owner: Session) {
  const res = await api().post('/api/v1/meta/sample-data').set(bearer(owner));
  if (res.status !== 201) throw new Error(`sample data failed ${JSON.stringify(res.body)}`);
  return res.body.data.created as number;
}

/** First record of a master matching a search term (any status). */
export async function find(owner: Session, master: string, search: string): Promise<Record<string, any>> {
  const res = await api().get(`/api/v1/${master}`).query({ search, status: 'all', limit: 5 }).set(bearer(owner));
  if (res.status !== 200 || !res.body.data.length) throw new Error(`no ${master} matching ${search}: ${JSON.stringify(res.body)}`);
  return res.body.data[0];
}

export const errorCode = (res: { body: { error?: { code?: string } } }) => res.body.error?.code;
