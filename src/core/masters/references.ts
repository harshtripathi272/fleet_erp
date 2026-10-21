import { Types } from 'mongoose';
import { ValidationError } from '../errors/index.js';
import { getRefTarget, referencesTo, refsOf } from './registry.js';
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
let extraUsage: ExtraUsage = async () => [];
/** Lets the configuration module count references held in custom fields and custom records. */
export const setExtraUsage = (fn: ExtraUsage) => { extraUsage = fn; };

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
  return [...usage, ...(await extraUsage(targetKey, id, activeOnly))];
}
