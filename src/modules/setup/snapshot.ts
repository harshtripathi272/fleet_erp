import mongoose from 'mongoose';
import { listMasters } from '../../core/masters/registry.js';
import type { Plain } from '../../core/masters/types.js';
import { storeForNew, storeOf } from '../../core/storage/index.js';
import { StoredFile } from '../files/file.model.js';

/**
 * A company's records as they stand on this copy, to travel in its package and be restored once on first start.
 * Ids are kept, so every link between records still holds. It never carries accounts, sessions or the audit log:
 * people are invited on the new copy, and its history starts there. Nor messages: on a new copy queued ones would
 * send twice, and WhatsApp button tokens would still answer.
 */
const { EJSON } = mongoose.mongo.BSON;
export type RecordsLevel = 'none' | 'masters' | 'everything';

/** Set by the company file, or belonging to the copy they were made on. */
const NEVER = new Set(['User', 'Role', 'Session', 'PasswordReset', 'SystemState', 'Company', 'Connection', 'AuditLog', 'Audit', 'IdempotencyKey', 'RateLimit', 'RecordLayout', 'RateFeedRun', 'StoredFile', 'OutboundMessage']);

function modelsFor(level: RecordsLevel) {
  if (level === 'none') return [];
  const models = level === 'everything'
    ? Object.values(mongoose.models)
    : [...new Set(listMasters().map((d) => d.model))];
  return models.filter((m) => !NEVER.has(m.modelName)) as mongoose.Model<unknown>[];
}

/** What a package would carry, for the screen. */
export async function snapshotSummary() {
  const counts = async (level: RecordsLevel) => {
    const rows = await Promise.all(modelsFor(level).map((m) => m.countDocuments()));
    return rows.reduce((a, b) => a + b, 0);
  };
  const files = await StoredFile.aggregate<{ count: number; size: number }>([{ $group: { _id: null, count: { $sum: 1 }, size: { $sum: '$size' } } }]);
  return { masters: await counts('masters'), everything: await counts('everything'), files: files[0]?.count ?? 0, fileBytes: files[0]?.size ?? 0 };
}

export interface SnapshotFile { id: string; path: string; key: string; mime: string }

/** The snapshot, and the uploaded files that go with it, as files for the package. */
export async function buildSnapshot(level: RecordsLevel, withFiles: boolean) {
  const collections: Record<string, unknown[]> = {};
  for (const model of modelsFor(level)) {
    const docs = await model.find().lean();
    if (docs.length) collections[model.modelName] = docs;
  }
  const uploads = new Map<string, Buffer>();
  const files: Plain[] = [];
  if (withFiles) {
    for (const f of await StoredFile.find().lean<Plain[]>()) {
      const chunks: Buffer[] = [];
      try {
        for await (const chunk of await (await storeOf(f)).open(String(f.key))) chunks.push(Buffer.from(chunk as Buffer));
      } catch { continue; }
      const path = `data/upload-${String(f._id)}.${String(f.key).split('.').pop()}`;
      uploads.set(path, Buffer.concat(chunks));
      files.push({ ...f, connectionId: undefined, packagePath: path });
    }
  }
  return { body: Buffer.from(EJSON.stringify({ collections, files })), uploads, records: Object.values(collections).reduce((a, d) => a + d.length, 0), fileCount: files.length };
}

/** Puts a snapshot back. A record already there is left as it is, so it's safe to run again. */
export async function restoreSnapshot(raw: Buffer, read: (name: string) => Promise<Buffer>) {
  const { collections, files } = EJSON.parse(raw.toString('utf8')) as { collections: Record<string, Plain[]>; files: Plain[] };
  let records = 0;
  for (const [name, docs] of Object.entries(collections)) {
    const model = mongoose.models[name];
    if (!model || !docs.length) continue;
    try {
      const done = await model.collection.insertMany(docs, { ordered: false });
      records += done.insertedCount;
    } catch (err) {
      const e = err as { code?: number; insertedCount?: number; result?: { insertedCount?: number } };
      if (e.code !== 11000) throw err;
      records += e.insertedCount ?? e.result?.insertedCount ?? 0;
    }
  }
  let restored = 0;
  for (const f of files) {
    const { packagePath, ...row } = f as Plain & { packagePath: string };
    if (await StoredFile.exists({ _id: row._id } as Plain)) continue;
    const { store, connectionId } = await storeForNew();
    await store.put(String(row.key), await read(packagePath), String(row.mime));
    await StoredFile.collection.insertOne({ ...row, ...(connectionId ? { connectionId: new mongoose.Types.ObjectId(connectionId) } : {}) } as never);
    restored += 1;
  }
  return { records, files: restored };
}
