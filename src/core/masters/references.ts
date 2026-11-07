import mongoose, { Types, type SchemaType } from 'mongoose';
import { ValidationError } from '../errors/index.js';
import { getMaster, getRefTarget, listMasters, referencesTo, refsOf } from './registry.js';
import type { MasterDefinition, Plain } from './types.js';

/** Collects the values found at a dotted path, walking through arrays. */
export function valuesAt(source: unknown, path: string): unknown[] {
  const [head, ...rest] = path.split('.');
  if (source === null || source === undefined || head === undefined) return [];
  if (Array.isArray(source)) return source.flatMap((item) => valuesAt(item, path));
  if (typeof source !== 'object') return [];
  const next = (source as Plain)[head];
  if (!rest.length) return Array.isArray(next) ? next : next === undefined || next === null ? [] : [next];
  return valuesAt(next, rest.join('.'));
}

const idString = (value: unknown) => value instanceof Types.ObjectId ? value.toHexString() : String(value);

/**
 * Every referenced record must exist and be active. Only the top-level keys in
 * `changedKeys` are checked, so untouched old references stay valid.
 */
export async function assertReferences(def: MasterDefinition, data: Plain, changedKeys?: Set<string>) {
  const problems: Record<string, string[]> = {};
  for (const ref of refsOf(def)) {
    if (ref.usageOnly) continue;
    const top = ref.path.split('.')[0]!;
    if (changedKeys && !changedKeys.has(top)) continue;
    const ids = [...new Set(valuesAt(data, ref.path).map(idString))];
    if (!ids.length) continue;
    const target = getRefTarget(ref.target);
    if (!target) throw new Error(`Unknown reference target ${ref.target}`);
    const filter: Plain = { _id: { $in: ids } };
    if (target.statusField) filter.status = 'active';
    if (ref.partyRoles?.length) filter.roles = { $in: ref.partyRoles };
    const found = await target.model.find(filter).select('_id').lean();
    const foundIds = new Set(found.map((d) => idString(d._id)));
    const missing = ids.filter((id) => !foundIds.has(id));
    if (missing.length) {
      const roleText = ref.partyRoles?.length ? ` with role ${ref.partyRoles.join(' or ')}` : '';
      (problems[ref.path] ??= []).push(`No active ${target.label.toLowerCase()}${roleText}: ${missing.join(', ')}`);
    }
  }
  if (Object.keys(problems).length) throw new ValidationError('Referenced records are missing or inactive', { references: problems });
}

export interface Usage { master: string; label: string; path: string; count: number; }

type ExtraUsage = (targetKey: string, id: string, activeOnly: boolean) => Promise<Usage[]>;
const sources: ExtraUsage[] = [];
/** Lets a module count references only it knows about: custom fields and records, or a trip that's still open. */
export const addUsageSource = (fn: ExtraUsage) => { sources.push(fn); };

/**
 * Records that aren't masters but point at them: trips, requests, loads, invoices and so on. Their schemas say what they
 * point at, so a new kind of record is covered without being listed. These only keep a record from being deleted; what
 * keeps one from being archived is open work, which the modules that know their records report through addUsageSource.
 */
const NOT_HISTORY = new Set(['VehicleState', 'ServiceState', 'DriverAccount', 'StoredFile', 'OutboundMessage', 'WaTemplateState', 'ActionToken']);
const RECORD_LABEL: Record<string, string> = {
  Trip: 'Trips', FundRequest: 'Money requests', Consignment: 'Loads', Expense: 'Expenses', Settlement: 'Settlements', Nomination: 'Nominations',
  DriverDocument: 'Driver documents', Invoice: 'Invoices', CustomerPayment: 'Customer payments', ExchangeDifference: 'Exchange differences',
  Company: 'Company settings', FinanceSettings: 'Finance settings',
};
interface HasPaths { eachPath: (fn: (path: string, type: SchemaType) => void) => unknown }
function refPaths(schema: HasPaths, prefix = '', out: { path: string; ref: string }[] = []) {
  schema.eachPath((path, type) => {
    const options = type.options as { ref?: string; type?: { ref?: string }[] };
    const ref = options.ref ?? options.type?.[0]?.ref;
    if (ref) out.push({ path: `${prefix}${path}`, ref });
    const inner = (type as { schema?: HasPaths }).schema;
    if (inner) refPaths(inner, `${prefix}${path}.`, out);
  });
  return out;
}
async function recordsUsing(targetKey: string, id: string): Promise<Usage[]> {
  const target = getMaster(targetKey)?.model.modelName;
  if (!target || target === 'User') return [];
  const masters = new Set(listMasters().map((m) => m.model.modelName));
  const usage: Usage[] = [];
  for (const name of mongoose.modelNames()) {
    if (masters.has(name) || NOT_HISTORY.has(name)) continue;
    const model = mongoose.model(name);
    for (const { path, ref } of refPaths(model.schema)) {
      if (ref !== target) continue;
      const count = await model.countDocuments({ [path]: new Types.ObjectId(id) });
      if (count) usage.push({ master: name, label: RECORD_LABEL[name] ?? name, path, count });
    }
  }
  return usage;
}

/** Counts records that point at `id`. `activeOnly` ignores archived records. */
export async function usageOf(targetKey: string, id: string, activeOnly = false): Promise<Usage[]> {
  const usage: Usage[] = [];
  for (const { master, path } of referencesTo(targetKey)) {
    const filter: Plain = { [path]: new Types.ObjectId(id) };
    if (activeOnly) filter.status = { $ne: 'archived' };
    if (master.key === targetKey) filter._id = { $ne: new Types.ObjectId(id) };
    const count = await master.model.countDocuments(filter);
    if (count) usage.push({ master: master.key, label: master.label, path, count });
  }
  if (!activeOnly) usage.push(...(await recordsUsing(targetKey, id)));
  for (const source of sources) usage.push(...(await source(targetKey, id, activeOnly)));
  return usage;
}
