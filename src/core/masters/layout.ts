import { Schema, model } from 'mongoose';
import { z } from 'zod';
import { ValidationError } from '../errors/index.js';
import { audit } from './audit.js';
import type { MasterDefinition, Plain } from './types.js';

/**
 * The company layer of a record type's definition (docs/entities.md, #65): what this company changed about a
 * master and its built-in fields and choices. The code gives the starting point; this record holds only the
 * company's changes, so "reset" is removing an entry. The merge with the code is done where the definition is
 * read (meta, import, validation).
 */

const fieldLayout = new Schema({
  path: { type: String, required: true },
  label: String,
  hint: String,
  hidden: Boolean,
  required: Boolean,
  defaultValue: Schema.Types.Mixed,
  section: String,
  order: Number,
  column: Boolean,
  columnOrder: Number,
  searchable: Boolean,
  inImport: Boolean,
}, { _id: false });

const choiceLayout = new Schema({
  path: { type: String, required: true },
  values: { type: [{ _id: false, value: { type: String, required: true }, label: String, order: Number, retired: Boolean }], default: [] },
}, { _id: false });

const layoutSchema = new Schema({
  entity: { type: String, required: true, unique: true },
  master: { type: { _id: false, label: String, singular: String, description: String, group: String, hidden: Boolean }, default: {} },
  sections: { type: [String], default: [] },
  fields: { type: [fieldLayout], default: [] },
  choices: { type: [choiceLayout], default: [] },
  revision: { type: Number, default: 0 },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true, versionKey: false, strict: 'throw' });

export const RecordLayout = model('RecordLayout', layoutSchema);

export interface FieldLayout { path: string; label?: string; hint?: string; hidden?: boolean; required?: boolean; defaultValue?: unknown; section?: string; order?: number; column?: boolean; columnOrder?: number; searchable?: boolean; inImport?: boolean }
export interface ChoiceLayout { path: string; values: { value: string; label?: string; order?: number; retired?: boolean }[] }
export interface Layout { entity: string; master: { label?: string; singular?: string; description?: string; group?: string; hidden?: boolean }; sections: string[]; fields: FieldLayout[]; choices: ChoiceLayout[]; revision: number }

const text = (max: number) => z.string().trim().min(1).max(max);
export const layoutInputSchema = z.strictObject({
  master: z.strictObject({ label: text(80).optional(), singular: text(80).optional(), description: text(500).optional(), group: text(80).optional(), hidden: z.boolean().optional() }).optional(),
  sections: z.array(text(60)).max(20).optional(),
  fields: z.array(z.strictObject({
    path: z.string().regex(/^[a-zA-Z][\w.]{0,120}$/), label: text(80).optional(), hint: text(300).optional(), hidden: z.boolean().optional(),
    required: z.boolean().optional(), defaultValue: z.unknown().optional(), section: text(60).optional(), order: z.number().int().min(0).max(10_000).optional(),
    column: z.boolean().optional(), columnOrder: z.number().int().min(0).max(1000).optional(), searchable: z.boolean().optional(), inImport: z.boolean().optional(),
  })).max(500).optional(),
  choices: z.array(z.strictObject({
    path: z.string().regex(/^[a-zA-Z][\w.]{0,120}$/),
    values: z.array(z.strictObject({ value: z.string().min(1).max(100), label: text(80).optional(), order: z.number().int().min(0).max(1000).optional(), retired: z.boolean().optional() })).max(200),
  })).max(100).optional(),
});
export type LayoutInput = z.infer<typeof layoutInputSchema>;

const empty = (entity: string): Layout => ({ entity, master: {}, sections: [], fields: [], choices: [], revision: 0 });

/* ---------- Reading, cached briefly so every request doesn't hit the database ---------- */

const TTL_MS = 10_000;
const cache = new Map<string, { at: number; layout: Layout }>();

export async function getLayout(entity: string): Promise<Layout> {
  const hit = cache.get(entity);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.layout;
  const doc = await RecordLayout.findOne({ entity }).lean<Layout>();
  const layout = doc ? { ...empty(entity), ...doc } : empty(entity);
  cache.set(entity, { at: Date.now(), layout });
  return layout;
}
export const clearLayoutCache = () => cache.clear();

/* ---------- What the code says a company may and may not change ---------- */

type Json = Record<string, any>;
const unwrap = (s: Json): Json => {
  const options = (s?.anyOf ?? s?.oneOf) as Json[] | undefined;
  if (options) return unwrap(options.find((o) => o.type !== 'null') ?? options[0]!);
  return s ?? {};
};

const pathCache = new Map<string, Map<string, Json>>();

/** Every field path of the create schema (one level of nesting, and inside arrays of objects), with its schema. */
export function fieldPaths(def: MasterDefinition): Map<string, Json> {
  const cached = pathCache.get(def.key);
  if (cached) return cached;
  const out = new Map<string, Json>();
  pathCache.set(def.key, out);
  let root: Json;
  try { root = z.toJSONSchema(def.createSchema, { io: 'input', unrepresentable: 'any' }) as Json; } catch { return out; }
  const walk = (schema: Json, prefix: string, depth: number) => {
    for (const [key, raw] of Object.entries((schema.properties ?? {}) as Record<string, Json>)) {
      const s = unwrap(raw);
      const path = prefix ? `${prefix}.${key}` : key;
      out.set(path, s);
      if (depth < 2 && s.type === 'object') walk(s, path, depth + 1);
      if (depth < 2 && s.type === 'array' && unwrap(s.items ?? {}).type === 'object') walk(unwrap(s.items), path, depth + 1);
    }
  };
  walk(root, '', 0);
  return out;
}

/** A path inside a list of entries (references.name): it has no single value, so it can't be required or defaulted. */
export const inList = (def: MasterDefinition, path: string) => {
  const paths = fieldPaths(def);
  const parts = path.split('.');
  return parts.slice(0, -1).some((_, i) => paths.get(parts.slice(0, i + 1).join('.'))?.type === 'array');
};

/** Fields the code itself requires at the top level: they can be renamed and moved, never hidden. */
export function systemRequired(def: MasterDefinition): Set<string> {
  try {
    const root = z.toJSONSchema(def.createSchema, { io: 'input', unrepresentable: 'any' }) as Json;
    return new Set([...((root.required ?? []) as string[]), ...(def.fixedFields ?? [])]);
  } catch {
    return new Set(def.fixedFields ?? []);
  }
}

/** Checks a company's changes against what the code allows, before they are saved. */
/** What a company may set on its own field (`custom.<key>`) here: where it sits and whether it is a list column (#97). */
const COMPANY_FIELD_LAYOUT = new Set(['path', 'section', 'order', 'column', 'columnOrder']);

function checkInput(def: MasterDefinition, input: LayoutInput, customKeys: string[] = []) {
  const paths = fieldPaths(def);
  const fixed = systemRequired(def);
  const errors: Record<string, string[]> = {};
  const add = (k: string, m: string) => (errors[k] ??= []).push(m);
  const own = new Set(customKeys.map((k) => `custom.${k}`));
  for (const f of input.fields ?? []) {
    // The company's own fields sit among the built-in ones (#97); their name, hint and rules are on the field itself.
    if (own.has(f.path)) {
      const other = Object.keys(f).filter((k) => !COMPANY_FIELD_LAYOUT.has(k) && (f as Plain)[k] !== undefined);
      if (other.length) add(f.path, 'Change the name, hint and rules of a company field in the field itself');
      continue;
    }
    if (!paths.has(f.path)) { add(f.path, 'No such field on this master'); continue; }
    if (f.hidden && fixed.has(f.path)) add(f.path, 'The app needs this field, so it can be renamed or moved but not hidden');
    if (f.required === false && fixed.has(f.path)) add(f.path, 'The app requires this field; a company can only make fields stricter');
    if ((f.required || f.defaultValue !== undefined) && inList(def, f.path)) add(f.path, 'A field inside a list of entries can\'t be required or given a default');
  }
  for (const c of input.choices ?? []) {
    const schema = paths.get(c.path);
    const values = (schema?.enum ?? unwrap(schema?.items ?? {}).enum) as string[] | undefined;
    if (!values) { add(c.path, 'Not a list of choices on this master'); continue; }
    for (const v of c.values) {
      if (!values.includes(v.value)) add(c.path, `"${v.value}" is not one of this list's values`);
      else if (v.retired && def.lockedChoices?.includes(c.path)) add(c.path, `The app acts on these choices, so "${v.value}" can be renamed but not retired`);
    }
    if (c.values.length && c.values.every((v) => v.retired)) add(c.path, 'At least one choice must stay offered');
  }
  if (Object.keys(errors).length) throw new ValidationError('These changes would break the master', errors);
}

/** Saves this company's changes to a master's definition; audited with what changed. */
export async function saveLayout(def: MasterDefinition, input: LayoutInput, ctx: { actorId?: string; requestId?: string; customKeys?: string[] }) {
  checkInput(def, input, ctx.customKeys);
  const before = await RecordLayout.findOne({ entity: def.key }).lean<Layout & { _id: unknown }>();
  const next = {
    master: input.master ?? before?.master ?? {},
    sections: input.sections ?? before?.sections ?? [],
    fields: input.fields ?? before?.fields ?? [],
    choices: input.choices ?? before?.choices ?? [],
  };
  const saved = await RecordLayout.findOneAndUpdate(
    { entity: def.key },
    { $set: { ...next, updatedBy: ctx.actorId }, $inc: { revision: 1 } },
    { upsert: true, new: true, lean: true },
  ) as unknown as Layout & { _id: unknown };
  cache.delete(def.key);
  const changes = (['master', 'sections', 'fields', 'choices'] as const)
    .filter((k) => JSON.stringify(before?.[k] ?? (k === 'master' ? {} : [])) !== JSON.stringify(next[k]))
    .map((k) => ({ path: `layout.${k}`, from: before?.[k] ?? null, to: next[k] }));
  if (changes.length) await audit({ entity: 'record-layouts', entityId: saved._id, action: 'update', actorId: ctx.actorId, requestId: ctx.requestId, summary: `Changed how ${def.label.toLowerCase()} are defined`, changes });
  return saved;
}

/* ---------- Enforcing the company's rules on records ---------- */

const get = (obj: Plain, path: string): unknown => path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Plain)[k] : undefined), obj);
const blank = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * A record must have what this company made required, and may not newly take a choice the company retired.
 * On update, only changed values are held to the retired-choice rule, so old records stay editable.
 */
export async function assertCompanyRules(def: MasterDefinition, record: Plain, before?: Plain) {
  const layout = await getLayout(def.key);
  if (!layout.fields.length && !layout.choices.length) return;
  const errors: Record<string, string[]> = {};
  for (const f of layout.fields) {
    if (f.required && !inList(def, f.path) && blank(get(record, f.path))) (errors[f.path] ??= []).push(`${f.label ?? 'This field'} is required by the company`);
  }
  for (const c of layout.choices) {
    const retired = new Set(c.values.filter((v) => v.retired).map((v) => v.value));
    if (!retired.size || inList(def, c.path)) continue;
    const now = get(record, c.path);
    const was = before ? get(before, c.path) : undefined;
    const values = (Array.isArray(now) ? now : [now]).filter((v) => typeof v === 'string') as string[];
    const old = new Set((Array.isArray(was) ? was : [was]) as string[]);
    for (const v of values) if (retired.has(v) && !old.has(v)) (errors[c.path] ??= []).push(`"${v}" is no longer offered`);
  }
  if (Object.keys(errors).length) throw new ValidationError('The record does not meet the company\'s rules', errors);
}

/** A company's default values, filled in on create where the input left them out. */
export async function applyDefaults(def: MasterDefinition, data: Plain) {
  const layout = await getLayout(def.key);
  for (const f of layout.fields) {
    if (f.defaultValue === undefined || inList(def, f.path) || !blank(get(data, f.path))) continue;
    // Set a nested default ("licence.issuingAuthority") without disturbing the rest of its object.
    const parts = f.path.split('.');
    let node: Plain = data;
    for (const p of parts.slice(0, -1)) node = (node[p] && typeof node[p] === 'object' ? node[p] : (node[p] = {})) as Plain;
    node[parts.at(-1)!] = f.defaultValue;
  }
}
