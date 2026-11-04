import { applyDefaults, assertCompanyRules } from './layout.js';
import { Types } from 'mongoose';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors/index.js';
import { logger } from '../logger/index.js';
import { AuditLog } from './audit.model.js';
import { audit, comparable, diff } from './audit.js';
import { validateDynamicValues, type DynamicField } from './dynamicFields.js';
import { assertReferences, usageOf, valuesAt, type Usage } from './references.js';
import type { MasterContext, MasterDefinition, Plain } from './types.js';

/* ---------- Pluggable providers (set by the configuration module) ---------- */

type FieldLoader = (entity: string) => Promise<DynamicField[]>;
type CodeGenerator = (entity: string, data: Plain) => Promise<string | null>;
let loadFields: FieldLoader = async () => [];
let generateCode: CodeGenerator = async () => null;
export const setCustomFieldLoader = (fn: FieldLoader) => { loadFields = fn; };
export const setCodeGenerator = (fn: CodeGenerator) => { generateCode = fn; };

/* ---------- Context and serialisation ---------- */

export interface ServiceContext {
  actorId?: string;
  requestId?: string;
  canSeeSensitive?: boolean;
}

const SYSTEM_KEYS = new Set(['_id', 'id', 'version', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'archivedAt', 'archivedBy', 'archiveReason']);
const HIDDEN_KEYS = new Set(['geo']);

function maskValue(value: unknown): unknown {
  if (typeof value !== 'string' || !value) return value;
  return value.length <= 4 ? '••••' : `••••${value.slice(-4)}`;
}

function maskPath(target: unknown, path: string[]): void {
  if (!target || typeof target !== 'object') return;
  if (Array.isArray(target)) { target.forEach((item) => maskPath(item, path)); return; }
  const [head, ...rest] = path;
  if (!head) return;
  const obj = target as Plain;
  if (!(head in obj)) return;
  if (rest.length) maskPath(obj[head], rest);
  else obj[head] = Array.isArray(obj[head]) ? (obj[head] as unknown[]).map(maskValue) : maskValue(obj[head]);
}

/** Plain JSON for the API: `id` instead of `_id`, masked sensitive values, read-time extras. */
export function serialize(def: MasterDefinition, doc: Plain, ctx: ServiceContext = {}): Plain {
  const plain = comparable(doc) as Plain;
  const { _id, ...rest } = plain;
  for (const key of [...HIDDEN_KEYS, ...(def.hidden ?? [])]) delete rest[key];
  const out: Plain = { id: _id, ...rest };
  if (!ctx.canSeeSensitive) for (const path of def.sensitive ?? []) maskPath(out, path.split('.'));
  return def.present ? { ...out, ...def.present(out) } : out;
}

/* ---------- Errors from MongoDB ---------- */

export function duplicateKeyError(err: unknown): ConflictError | null {
  if (!err || typeof err !== 'object' || (err as { code?: number }).code !== 11000) return null;
  const keyPattern = (err as { keyPattern?: Plain }).keyPattern ?? {};
  const fields = Object.keys(keyPattern).filter((k) => k !== 'status' && k !== 'open');
  return new ConflictError(`A record with the same ${fields.join(' + ') || 'key'} already exists`, { fields });
}

async function saveDoc(doc: { save: () => Promise<unknown> }) {
  try {
    await doc.save();
  } catch (err) {
    const dup = duplicateKeyError(err);
    if (dup) throw dup;
    if (err && typeof err === 'object' && (err as { name?: string }).name === 'VersionError') {
      throw new ConflictError('This record was changed by someone else. Reload it and try again.');
    }
    throw err;
  }
}

/* ---------- Shared checks ---------- */

function assertValidity(data: Plain) {
  const from = data.validFrom instanceof Date ? data.validFrom : null;
  const to = data.validTo instanceof Date ? data.validTo : null;
  if (from && to && to < from) throw new ValidationError('Valid until must be on or after valid from', { validTo: ['Before validFrom'] });
}

async function validateCustom(def: MasterDefinition, input: Plain | undefined, base: Plain | undefined): Promise<Plain> {
  if (def.customFields === false) {
    if (input && Object.keys(input).length) throw new ValidationError(`${def.label} do not accept custom fields`);
    return {};
  }
  const fields = await loadFields(def.key);
  return validateDynamicValues(fields, input ?? {}, base ?? {});
}

/**
 * A role without the "sensitive" permission sees masked values, so it may not write them either:
 * setting, changing or clearing a sensitive field is refused. Internal callers (no request) are not limited.
 */
function assertSensitiveWritable(def: MasterDefinition, input: Plain, before: Plain | undefined, ctx: ServiceContext) {
  if (ctx.canSeeSensitive !== false || !def.sensitive?.length) return;
  const touched = def.sensitive.filter((path) => {
    const top = path.split('.')[0]!;
    if (!(top in input)) return false;
    if (valuesAt(input, path).length) return true;
    // Clearing the field (or its parent object) removes a value the caller cannot see.
    return Boolean(before && valuesAt(before, path).length && JSON.stringify(comparable(valuesAt(input, path))) !== JSON.stringify(comparable(valuesAt(before, path))));
  });
  if (touched.length) throw new ForbiddenError('Your role cannot change sensitive fields', { sensitive: touched });
}

/* ---------- Queries ---------- */

export interface ListQuery {
  page: number;
  limit: number;
  search?: string;
  status?: 'active' | 'inactive' | 'archived' | 'all';
  sort?: string;
  updatedSince?: Date;
  [filter: string]: unknown;
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function buildFilter(def: MasterDefinition, query: ListQuery): Plain {
  const and: Plain[] = [];
  if (!query.status) and.push({ status: { $ne: 'archived' } });
  else if (query.status !== 'all') and.push({ status: query.status });
  if (query.search) {
    const pattern = new RegExp(escapeRegex(query.search), 'i');
    and.push({ $or: def.searchFields.map((field) => ({ [field]: pattern })) });
  }
  if (query.updatedSince) and.push({ updatedAt: { $gte: query.updatedSince } });
  for (const [key, spec] of Object.entries(def.filters ?? {})) {
    const value = query[key];
    if (value !== undefined) and.push(spec.apply(value as never));
  }
  return and.length ? { $and: and } : {};
}

export async function list(def: MasterDefinition, query: ListQuery, ctx: ServiceContext = {}) {
  const filter = buildFilter(def, query);
  const sortKey = query.sort ?? def.defaultSort ?? def.sortFields[0] ?? 'createdAt';
  const sort: Record<string, 1 | -1> = sortKey.startsWith('-') ? { [sortKey.slice(1)]: -1 } : { [sortKey]: 1 };
  sort._id = 1;
  const [rows, total] = await Promise.all([
    def.model.find(filter).sort(sort).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
    def.model.countDocuments(filter),
  ]);
  return { data: rows.map((row) => serialize(def, row as Plain, ctx)), total, page: query.page, limit: query.limit };
}

async function loadDoc(def: MasterDefinition, id: string) {
  const doc = await def.model.findById(id);
  if (!doc) throw new NotFoundError(`${def.singular} not found`);
  return doc;
}

export async function getById(def: MasterDefinition, id: string, ctx: ServiceContext = {}) {
  const doc = await def.model.findById(id).lean();
  if (!doc) throw new NotFoundError(`${def.singular} not found`);
  return serialize(def, doc as Plain, ctx);
}

/* ---------- Writes ---------- */

export async function create(def: MasterDefinition, input: Plain, ctx: ServiceContext = {}) {
  const data: Plain = { ...input };
  if (def.autoCode && !data.code) {
    const generated = await generateCode(def.key, data);
    if (!generated) throw new ValidationError('Code is required', { code: ['Required, or set up a numbering series for this master'] });
    data.code = generated;
  }
  assertSensitiveWritable(def, data, undefined, ctx);
  assertValidity(data);
  await assertReferences(def, data);
  data.custom = await validateCustom(def, data.custom as Plain | undefined, undefined);
  // What this company added to the code's rules: its defaults, required fields and retired choices (#65).
  await applyDefaults(def, data);
  await assertCompanyRules(def, data);
  const context: MasterContext = { mode: 'create', actorId: ctx.actorId, requestId: ctx.requestId };
  const prepared = (await def.prepare?.(data, context)) ?? data;
  const doc = new def.model({ ...prepared, createdBy: ctx.actorId, updatedBy: ctx.actorId });
  await saveDoc(doc);
  const saved = doc.toObject() as Plain;
  await audit({ entity: def.key, entityId: doc._id, action: 'create', actorId: ctx.actorId, requestId: ctx.requestId, changes: diff({}, saved, def.sensitive) });
  logger.info({ entity: def.key, id: String(doc._id), requestId: ctx.requestId }, 'Record created');
  return serialize(def, saved, ctx);
}

export async function update(def: MasterDefinition, id: string, input: Plain, ctx: ServiceContext = {}) {
  const doc = await loadDoc(def, id);
  const before = doc.toObject() as Plain;
  if (before.status === 'archived') throw new ConflictError(`Restore this ${def.singular.toLowerCase()} before editing it`);
  const { version, ...changes } = input;
  assertSensitiveWritable(def, changes, before, ctx);
  if (version !== before.version) {
    throw new ConflictError('This record was changed by someone else. Reload it and try again.', { currentVersion: before.version });
  }
  for (const key of def.immutable ?? []) {
    if (key in changes && JSON.stringify(comparable(changes[key])) !== JSON.stringify(comparable(before[key]))) {
      throw new ValidationError(`${key} cannot be changed after creation`, { [key]: ['Immutable'] });
    }
  }
  const candidate: Plain = { ...before };
  for (const [key, value] of Object.entries(changes)) {
    if (key === 'custom') continue;
    if (value === null) delete candidate[key];
    else candidate[key] = value;
  }
  if ('custom' in changes) candidate.custom = await validateCustom(def, (changes.custom ?? {}) as Plain, (before.custom ?? {}) as Plain);
  assertValidity(candidate);
  await assertCompanyRules(def, candidate, before);
  await assertReferences(def, candidate, new Set(Object.keys(changes)));
  const context: MasterContext = { mode: 'update', actorId: ctx.actorId, requestId: ctx.requestId, id, existing: before };
  const prepared = (await def.prepare?.(candidate, context)) ?? candidate;

  const keys = new Set([...Object.keys(prepared), ...Object.keys(before)]);
  for (const key of keys) {
    if (SYSTEM_KEYS.has(key)) continue;
    const next = prepared[key];
    if (JSON.stringify(comparable(next)) === JSON.stringify(comparable(before[key]))) continue;
    doc.set(key, next === undefined ? undefined : next);
  }
  if (!doc.isModified()) return serialize(def, before, ctx);
  doc.set('updatedBy', ctx.actorId);
  await saveDoc(doc);
  const after = doc.toObject() as Plain;
  await audit({ entity: def.key, entityId: doc._id, action: 'update', actorId: ctx.actorId, requestId: ctx.requestId, changes: diff(before, after, def.sensitive) });
  return serialize(def, after, ctx);
}

export async function archive(def: MasterDefinition, id: string, reason: string | undefined, ctx: ServiceContext = {}) {
  const doc = await loadDoc(def, id);
  const before = doc.toObject() as Plain;
  if (before.status === 'archived') throw new ConflictError(`${def.singular} is already archived`);
  const inUse = await usageOf(def.key, id, true);
  if (inUse.length) {
    throw new ConflictError(`${def.singular} is still used by active records. Archive or change those first.`, { usage: inUse });
  }
  await def.beforeArchive?.(before, { mode: 'update', actorId: ctx.actorId, id, existing: before });
  doc.set({ status: 'archived', archivedAt: new Date(), archivedBy: ctx.actorId, archiveReason: reason, updatedBy: ctx.actorId });
  await saveDoc(doc);
  await audit({ entity: def.key, entityId: doc._id, action: 'archive', summary: reason, actorId: ctx.actorId, requestId: ctx.requestId });
  return serialize(def, doc.toObject() as Plain, ctx);
}

export async function restore(def: MasterDefinition, id: string, ctx: ServiceContext = {}) {
  const doc = await loadDoc(def, id);
  if (doc.get('status') !== 'archived') throw new ConflictError(`${def.singular} is not archived`);
  doc.set({ status: 'active', archivedAt: undefined, archivedBy: undefined, archiveReason: undefined, updatedBy: ctx.actorId });
  await saveDoc(doc);
  await audit({ entity: def.key, entityId: doc._id, action: 'restore', actorId: ctx.actorId, requestId: ctx.requestId });
  return serialize(def, doc.toObject() as Plain, ctx);
}

export async function remove(def: MasterDefinition, id: string, ctx: ServiceContext = {}) {
  const doc = await loadDoc(def, id);
  const inUse = await usageOf(def.key, id, false);
  if (inUse.length) throw new ConflictError(`${def.singular} is referenced by other records and can only be archived`, { usage: inUse });
  await def.beforeDelete?.(doc.toObject() as Plain, { mode: 'update', actorId: ctx.actorId, id, existing: doc.toObject() as Plain });
  await doc.deleteOne();
  await audit({ entity: def.key, entityId: doc._id, action: 'delete', actorId: ctx.actorId, requestId: ctx.requestId, changes: diff(doc.toObject() as Plain, {}, def.sensitive) });
}

export async function usage(def: MasterDefinition, id: string): Promise<{ total: number; usage: Usage[] }> {
  if (!(await def.model.exists({ _id: id }))) throw new NotFoundError(`${def.singular} not found`);
  const all = await usageOf(def.key, id, false);
  return { total: all.reduce((sum, u) => sum + u.count, 0), usage: all };
}

export async function history(def: MasterDefinition, id: string, page: number, limit: number) {
  if (!(await def.model.exists({ _id: id }))) {
    const deleted = await AuditLog.exists({ entity: def.key, entityId: new Types.ObjectId(id), action: 'delete' });
    if (!deleted) throw new NotFoundError(`${def.singular} not found`);
  }
  const filter = { entity: def.key, entityId: new Types.ObjectId(id) };
  const [rows, total] = await Promise.all([
    AuditLog.find(filter).sort({ at: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).populate<{ actorId: { _id: Types.ObjectId; name?: string } | null }>('actorId', 'name').lean(),
    AuditLog.countDocuments(filter),
  ]);
  // The person's name travels with each entry so screens never show a bare user id.
  return {
    data: rows.map(({ actorId: actor, ...r }) => {
      const { _id, ...rest } = comparable(r) as Plain;
      return { id: _id, ...rest, actorId: actor?._id ? String(actor._id) : undefined, actorName: actor?.name };
    }),
    total, page, limit,
  };
}
