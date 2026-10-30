import type { Model } from 'mongoose';
import type { MasterDefinition, RefSpec } from './types.js';

interface RefTarget { key: string; model: Model<any>; label: string; titleField: string; statusField: boolean; }

const masters = new Map<string, MasterDefinition>();
const targets = new Map<string, RefTarget>();

export function registerMaster(def: MasterDefinition): MasterDefinition {
  if (masters.has(def.key)) throw new Error(`Master "${def.key}" registered twice`);
  masters.set(def.key, def);
  targets.set(def.key, { key: def.key, model: def.model, label: def.singular, titleField: def.titleField ?? 'name', statusField: true });
  return def;
}

/** Records that are not masters (users, roles) but may be referenced. */
export function registerRefTarget(target: RefTarget) {
  targets.set(target.key, target);
}

export const getMaster = (key: string) => masters.get(key);
export const listMasters = () => [...masters.values()];
export const getRefTarget = (key: string) => targets.get(key);

/** Every reference declared by a master, including the shared branch scope. */
export function refsOf(def: MasterDefinition): RefSpec[] {
  const refs = [...(def.refs ?? [])];
  if (!refs.some((r) => r.path === 'branchIds')) refs.push({ path: 'branchIds', target: 'branches' });
  return refs;
}

/** Reverse index: which master paths point at the given target. */
export function referencesTo(targetKey: string): Array<{ master: MasterDefinition; path: string }> {
  const out: Array<{ master: MasterDefinition; path: string }> = [];
  for (const def of masters.values()) {
    for (const ref of refsOf(def)) if (ref.target === targetKey) out.push({ master: def, path: ref.path });
  }
  return out;
}
