import { Types, type Model } from 'mongoose';
import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors/index.js';
import { defineMaster } from '../../core/masters/define.js';
import { validateDynamicValues, type DynamicField } from '../../core/masters/dynamicFields.js';
import { GROUPS } from '../../core/masters/groups.js';
import { getMaster, getRefTarget, listMasters, registerMaster, registerRefTarget, setRefResolver } from '../../core/masters/registry.js';
import { Invoice, CustomerPayment } from '../finance/billing/billing.model.js';
import { Consignment } from '../operations/models/cargo.model.js';
import { FundRequest } from '../operations/models/funding.model.js';
import { Expense, Nomination, Settlement } from '../operations/models/money.model.js';
import { Trip } from '../operations/models/trip.model.js';
import { setExtraUsage, type Usage } from '../../core/masters/references.js';
import * as MasterService from '../../core/masters/service.js';
import { setCustomFieldLoader, type ListQuery, type ServiceContext } from '../../core/masters/service.js';
import type { MasterDefinition, Plain } from '../../core/masters/types.js';
import * as S from './configuration.schema.js';
import { CustomMaster, CustomRecord, FieldDefinition, List } from './models/configuration.model.js';

const push = (errors: Record<string, string[]>, key: string, message: string) => { (errors[key] ??= []).push(message); };

/* ---------- Simple lists ---------- */

export const listDefinition = defineMaster({
  key: 'lists', label: 'Simple lists', singular: 'List', group: GROUPS.configuration,
  description: 'Short lists with no master of their own (blood groups, colours, marital status). Select fields can draw their options from a list.',
  model: List, createSchema: S.createListSchema, updateSchema: S.updateListSchema,
  customFields: false,
  async prepare(data: Plain) {
    const values = data.values as Array<{ value: string; order?: number }>;
    if (new Set(values.map((v) => v.value)).size !== values.length) throw new ValidationError('List values must be unique', { values: ['Duplicate value'] });
    return { ...data, values: values.map((v, i) => ({ ...v, order: v.order ?? i + 1 })).sort((a, b) => a.order - b.order) };
  },
});

export async function listValues(code: string) {
  const list = await List.findOne({ code, status: 'active' }).collation({ locale: 'en', strength: 2 }).lean();
  if (!list) throw new NotFoundError('List not found');
  return { code: list.code, name: list.name, values: ((list.values ?? []) as Array<{ value: string; label: string; active?: boolean }>).filter((v) => v.active !== false) };
}

/* ---------- Shared field rules ---------- */

async function checkFieldSpec(field: Plain, errors: Record<string, string[]>, where: string) {
  const type = String(field.type);
  const isSelect = type === 'select' || type === 'multi_select';
  const options = field.options as string[] | undefined;
  if (isSelect && !options?.length === !field.listId) push(errors, where, `${field.key}: select fields need options or a list, not both`);
  if (!isSelect && (options || field.listId)) push(errors, where, `${field.key}: only select fields take options or a list`);
  if (options && new Set(options).size !== options.length) push(errors, where, `${field.key}: options must be unique`);
  if (field.listId && !(await List.exists({ _id: field.listId, status: 'active' }))) push(errors, where, `${field.key}: list not found or inactive`);
  if (type === 'reference') {
    if (!field.referenceMaster || !getRefTarget(String(field.referenceMaster))) push(errors, where, `${field.key}: choose an existing master to reference`);
  } else if (field.referenceMaster) push(errors, where, `${field.key}: only reference fields name a master`);
  if (type !== 'number' && (field.min !== undefined || field.max !== undefined)) push(errors, where, `${field.key}: min/max apply to number fields`);
  if (field.min !== undefined && field.max !== undefined && Number(field.min) > Number(field.max)) push(errors, where, `${field.key}: min is greater than max`);
  if (!['text', 'long_text'].includes(type) && field.maxLength !== undefined) push(errors, where, `${field.key}: maxLength applies to text fields`);
  if (type !== 'text' && field.pattern) push(errors, where, `${field.key}: pattern applies to text fields`);
}

async function resolveOptions(fields: Plain[]): Promise<DynamicField[]> {
  const listIds = fields.map((f) => f.listId).filter(Boolean);
  const lists = listIds.length ? await List.find({ _id: { $in: listIds } }).lean() : [];
  return fields.map((f) => {
    const list = f.listId ? lists.find((l) => String(l._id) === String(f.listId)) : undefined;
    const options = list ? (list.values as Array<{ value: string; active?: boolean }>).filter((v) => v.active !== false).map((v) => v.value) : (f.options as string[] | undefined);
    return { ...(f as unknown as DynamicField), options };
  }).sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

/** Fields as a form needs them: each select carries its choices, from its own options or its list's active values. */
export async function withChoices(fields: Plain[]) {
  const listIds = fields.map((f) => f.listId).filter(Boolean);
  const lists = listIds.length ? await List.find({ _id: { $in: listIds } }).lean() : [];
  return fields.map((f) => {
    const list = f.listId ? lists.find((l) => String(l._id) === String(f.listId)) : undefined;
    const choices = list
      ? (list.values as Array<{ value: string; label: string; order?: number; active?: boolean }>)
        .filter((v) => v.active !== false)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((v) => ({ value: v.value, label: v.label }))
      : (f.options as string[] | undefined)?.map((value) => ({ value, label: value }));
    return choices ? { ...f, choices } : f;
  });
}

/* ---------- Custom fields on built-in masters ---------- */

export const fieldDefinitionDefinition = defineMaster({
  key: 'field-definitions', label: 'Custom fields', singular: 'Custom field', group: GROUPS.configuration, lockedChoices: ['type'],
  description: 'Extra fields a company adds to any built-in master (e.g. "Union membership no." on Drivers). They show under "Company fields" on that master and are checked on every save.',
  model: FieldDefinition, createSchema: S.createFieldDefinitionSchema, updateSchema: S.updateFieldDefinitionSchema,
  searchFields: ['key', 'label', 'entity'], sortFields: ['entity', 'order', 'key', 'createdAt'], defaultSort: 'entity', titleField: 'label',
  refs: [{ path: 'listId', target: 'lists' }],
  immutable: ['entity', 'key', 'type'],
  customFields: false,
  filters: { entity: { schema: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/), apply: (v: string) => ({ entity: v }), description: 'Custom fields of this master' } },
  async prepare(data: Plain, ctx) {
    const errors: Record<string, string[]> = {};
    const target = getMaster(String(data.entity));
    if (!target || target.customFields === false) push(errors, 'entity', `Custom fields are not supported on "${data.entity}"`);
    else if (Object.keys(target.model.schema.paths).some((p) => p === data.key || p.startsWith(`${data.key}.`))) push(errors, 'key', `"${data.key}" is already a built-in field of ${target.label}`);
    await checkFieldSpec(data, errors, 'field');
    if (Object.keys(errors).length) throw new ValidationError('Custom field is not valid', errors);
    if (target && data.required && data.status !== 'inactive' && (ctx.mode === 'create' || !ctx.existing?.required || ctx.existing?.status !== 'active')) {
      const missing = await target.model.countDocuments({ status: { $ne: 'archived' }, [`custom.${data.key}`]: { $exists: false } });
      if (missing) throw new ConflictError(`${missing} existing ${target.label.toLowerCase()} have no value for this field. Fill them in, or add it as optional first.`, { impact: { missing } });
    }
    return data;
  },
});

/* ---------- Custom masters and their records ---------- */

const builtInKeys = () => new Set(listMasters().map((m) => m.key));

export const customMasterDefinition = defineMaster({
  key: 'custom-masters', label: 'Custom masters', singular: 'Custom master', group: GROUPS.configuration,
  description: 'Masters a company defines itself, with its own fields, e.g. Health cards or Police checkpoints. Records live under /custom-masters/:id/records.',
  model: CustomMaster, createSchema: S.createCustomMasterSchema, updateSchema: S.updateCustomMasterSchema,
  refs: [{ path: 'fields.listId', target: 'lists' }],
  immutable: ['code'],
  customFields: false,
  async prepare(data: Plain, ctx) {
    const errors: Record<string, string[]> = {};
    if (builtInKeys().has(String(data.code))) push(errors, 'code', `"${data.code}" is a built-in master`);
    const fields = data.fields as Plain[];
    const keys = fields.map((f) => String(f.key));
    if (new Set(keys).size !== keys.length) push(errors, 'fields', 'Field keys must be unique');
    for (const f of fields) await checkFieldSpec(f, errors, 'fields');
    const title = fields.find((f) => f.key === data.titleField);
    if (!title) push(errors, 'titleField', 'Must be one of the field keys');
    else if (title.type !== 'text' || !title.required) push(errors, 'titleField', 'The title field must be a required text field');
    if (Object.keys(errors).length) throw new ValidationError('Custom master is not valid', errors);
    if (ctx.mode === 'update' && ctx.id) {
      const before = new Map(((ctx.existing?.fields ?? []) as Plain[]).map((f) => [String(f.key), f]));
      for (const f of fields) {
        const old = before.get(String(f.key));
        const filter = { masterId: new Types.ObjectId(ctx.id), status: { $ne: 'archived' } };
        if (old && old.type !== f.type && (await CustomRecord.countDocuments({ ...filter, [`data.${f.key}`]: { $exists: true } }))) {
          throw new ConflictError(`Field "${f.key}" has values; its type cannot change from ${old.type} to ${f.type}`);
        }
        if (f.required && !old?.required) {
          const missing = await CustomRecord.countDocuments({ ...filter, [`data.${f.key}`]: { $exists: false } });
          if (missing) throw new ConflictError(`${missing} record(s) have no value for "${f.key}". Fill them in before making it required.`, { impact: { missing } });
        }
      }
    }
    return data;
  },
});

/** Generic definition used for custom records (permissions, audit, serialisation). */
export const customRecordDefinition = registerMaster(defineMaster({
  key: 'custom-records', label: 'Custom records', singular: 'Record', group: GROUPS.configuration,
  description: 'Records of custom masters. Validated against the master\'s fields on every save.',
  model: CustomRecord, createSchema: S.createCustomRecordSchema, updateSchema: S.updateCustomRecordSchema,
  searchFields: ['title'], sortFields: ['title', 'createdAt', 'updatedAt'], defaultSort: 'title', titleField: 'title',
  customFields: false,
  refs: [{ path: 'masterId', target: 'custom-masters' }],
  filters: { masterId: { schema: z.string(), apply: (v: string) => ({ masterId: new Types.ObjectId(v) }), description: 'Records of one custom master' } },
}));

async function loadCustomMaster(masterId: string, mustBeActive = false) {
  const master = await CustomMaster.findById(masterId).lean();
  if (!master) throw new NotFoundError('Custom master not found');
  if (mustBeActive && master.status !== 'active') throw new ConflictError('This custom master is not active');
  return master;
}

/** A custom master's fields for its record form, with select choices filled in. */
export async function recordFields(masterId: string) {
  const master = await loadCustomMaster(masterId);
  return withChoices(master.fields as Plain[]);
}

/** A per-master definition whose prepare validates `data` against that master's fields. */
async function recordDefinitionFor(masterId: string, mustBeActive: boolean): Promise<MasterDefinition> {
  const master = await loadCustomMaster(masterId, mustBeActive);
  const fields = await resolveOptions(master.fields as Plain[]);
  return {
    ...customRecordDefinition,
    layoutKey: customKey(masterId),
    async prepare(data: Plain, ctx) {
      if (ctx.mode === 'update' && String(ctx.existing?.masterId) !== masterId) throw new NotFoundError('Record not found');
      const base = ctx.mode === 'update' ? (ctx.existing?.data ?? {}) as Plain : {};
      const incoming = ctx.mode === 'create' || data.data !== ctx.existing?.data ? (data.data ?? {}) as Plain : {};
      const values = await validateDynamicValues(fields, incoming, base, 'data');
      return { ...data, masterId: new Types.ObjectId(masterId), data: values, title: String(values[String(master.titleField)] ?? '') };
    },
  };
}

async function assertRecordOf(masterId: string, id: string) {
  const record = await CustomRecord.findById(id).select('masterId').lean();
  if (!record || String(record.masterId) !== masterId) throw new NotFoundError('Record not found');
}

export async function listRecords(masterId: string, query: ListQuery, ctx: ServiceContext) {
  await loadCustomMaster(masterId);
  return MasterService.list({ ...customRecordDefinition, layoutKey: customKey(masterId) }, { ...query, masterId }, ctx);
}
export async function getRecord(masterId: string, id: string, ctx: ServiceContext) {
  await assertRecordOf(masterId, id);
  return MasterService.getById({ ...customRecordDefinition, layoutKey: customKey(masterId) }, id, ctx);
}
export async function createRecord(masterId: string, input: Plain, ctx: ServiceContext) {
  return MasterService.create(await recordDefinitionFor(masterId, true), input, ctx);
}
export async function updateRecord(masterId: string, id: string, input: Plain, ctx: ServiceContext) {
  await assertRecordOf(masterId, id);
  return MasterService.update(await recordDefinitionFor(masterId, true), id, input, ctx);
}
export async function archiveRecord(masterId: string, id: string, reason: string | undefined, ctx: ServiceContext) {
  await assertRecordOf(masterId, id);
  return MasterService.archive(customRecordDefinition, id, reason, ctx);
}
export async function restoreRecord(masterId: string, id: string, ctx: ServiceContext) {
  await assertRecordOf(masterId, id);
  return MasterService.restore(customRecordDefinition, id, ctx);
}
export async function removeRecord(masterId: string, id: string, ctx: ServiceContext) {
  await assertRecordOf(masterId, id);
  return MasterService.remove(customRecordDefinition, id, ctx);
}

/* ---------- Wiring into the generic engine ---------- */

setCustomFieldLoader(async (entity) => {
  const defs = await FieldDefinition.find({ entity, status: 'active' }).lean();
  return resolveOptions(defs as Plain[]);
});

setExtraUsage(async (targetKey, id, activeOnly) => {
  const usage: Usage[] = [];
  const statusFilter = activeOnly ? { status: { $ne: 'archived' } } : {};
  for (const field of await FieldDefinition.find({ type: 'reference', referenceMaster: targetKey }).lean()) {
    const master = getMaster(String(field.entity));
    if (!master) continue;
    const count = await master.model.countDocuments({ [`custom.${field.key}`]: id, ...statusFilter });
    if (count) usage.push({ master: master.key, label: master.label, path: `custom.${field.key}`, count });
  }
  for (const cm of await CustomMaster.find({ 'fields.referenceMaster': targetKey }).lean()) {
    for (const field of (cm.fields as Plain[]).filter((f) => f.type === 'reference' && f.referenceMaster === targetKey)) {
      const count = await CustomRecord.countDocuments({ masterId: cm._id, [`data.${field.key}`]: id, ...statusFilter });
      if (count) usage.push({ master: 'custom-records', label: `${cm.name} records`, path: `data.${field.key}`, count });
    }
  }
  return usage;
});

/* ---------- References to any record type (#68) ---------- */

/** Operational records a company field may point at, by their number. */
const RECORD_TARGETS: Array<{ key: string; model: Model<any>; label: string }> = [
  { key: 'trips', model: Trip, label: 'Trip' }, { key: 'nominations', model: Nomination, label: 'Nomination' },
  { key: 'fund-requests', model: FundRequest, label: 'Fuel or cash request' }, { key: 'expenses', model: Expense, label: 'Expense' },
  { key: 'consignments', model: Consignment, label: 'Loading' }, { key: 'settlements', model: Settlement, label: 'Settlement' },
  { key: 'invoices', model: Invoice as unknown as Model<any>, label: 'Invoice' }, { key: 'payments-received', model: CustomerPayment as unknown as Model<any>, label: 'Payment received' },
];
for (const t of RECORD_TARGETS) registerRefTarget({ ...t, titleField: 'number', statusField: false, kind: 'record' });

/** The key a custom master's records go by, wherever a record type is named: custom-<its id>. */
export const customKey = (id: unknown) => `custom-${String(id)}`;
export const CUSTOM_KEY = /^custom-([0-9a-f]{24})$/;
setRefResolver((key) => {
  const m = CUSTOM_KEY.exec(key);
  return m ? { key, model: CustomRecord, label: 'Record', titleField: 'title', statusField: true, filter: { masterId: new Types.ObjectId(m[1]) }, kind: 'custom' } : undefined;
});

/**
 * A custom master as a record type, with the same shape as a built-in master's definition (#68): its records'
 * values are `data.<key>`, so the company layer (field permissions, list views) applies to it like any master.
 */
export function customRecordTypeOf(master: Plain): MasterDefinition {
  const fields = (master.fields ?? []) as Plain[];
  const shape = Object.fromEntries(fields.map((f) => [String(f.key), f.required ? z.unknown() : z.unknown().optional()]));
  return {
    ...customRecordDefinition,
    key: customKey(master._id), label: String(master.name), singular: String(master.name), description: String(master.description ?? ''),
    layoutKey: customKey(master._id),
    createSchema: z.strictObject({ data: z.strictObject(shape) }),
    filters: {},
  };
}

/** The custom master behind a custom-<id> key, as a record type; undefined for any other key. */
export async function customRecordType(key: string): Promise<MasterDefinition | undefined> {
  const m = CUSTOM_KEY.exec(key);
  if (!m) return undefined;
  const master = await CustomMaster.findById(m[1]).lean() as Plain | null;
  return master ? customRecordTypeOf(master) : undefined;
}

export const masters: MasterDefinition[] = [listDefinition, fieldDefinitionDefinition, customMasterDefinition];
