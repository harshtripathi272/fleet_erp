import { z } from 'zod';
import { ConflictError, NotFoundError } from '../errors/index.js';
import { fullLabel } from './labels.js';
import { getLayout, systemRequired } from './layout.js';
import { getMaster, getRefTarget, refsOf } from './registry.js';
import { companyFieldsOf, create, type ServiceContext } from './service.js';
import { isFileType } from './fileFields.js';
import type { DynamicField } from './dynamicFields.js';
import type { MasterDefinition, Plain } from './types.js';

/**
 * Loading a master from a spreadsheet (issue #41). The columns come from the master's create schema, so a
 * master added later can be imported with no change here. A row goes through the same create as the screens
 * (rules, numbering, audit), after a dry run that shows every problem by row and column.
 */

type Kind = 'text' | 'number' | 'boolean' | 'date' | 'choice' | 'ref' | 'money' | 'list';
export interface ImportColumn {
  path: string;
  label: string;
  kind: Kind;
  required: boolean;
  choices?: string[];
  /** How each choice is named on screen; a cell may give the name or the stored value. */
  choiceNames?: Record<string, string>;
  /** The master a reference column points at; the cell holds its code or name. */
  target?: string;
  /** What a list holds: references, choices or plain text, separated by ";" in the cell. */
  of?: 'ref' | 'choice' | 'text';
}

export interface RowResult {
  /** The spreadsheet row: 2 is the first row under the header. */
  row: number;
  status: 'ready' | 'exists' | 'invalid' | 'created' | 'failed';
  problems: { column: string; message: string }[];
  id?: string;
}

/** Fields a spreadsheet can't sensibly hold, or that the system fills in. */
const SKIP = new Set(['externalRefs', 'attachments', 'custom', 'version']);
const OBJECT_ID = '^[0-9a-fA-F]{24}$';
export const MAX_ROWS = 500;

type Json = Record<string, any>;
const unwrap = (s: Json): Json => {
  const options = (s.anyOf ?? s.oneOf) as Json[] | undefined;
  if (options) return unwrap(options.find((o) => o.type !== 'null') ?? options[0]!);
  return s;
};
const normal = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/** A cell's choice by its stored value or by the name the screens show. */
const pickChoice = (c: ImportColumn, text: string) => c.choices!.find((o) => normal(o) === normal(text) || (c.choiceNames?.[o] && normal(c.choiceNames[o]!) === normal(text)));
const choiceList = (c: ImportColumn) => c.choices!.map((o) => c.choiceNames?.[o] ?? o).join(', ');

function columnFor(def: MasterDefinition, path: string, raw: Json, required: boolean): ImportColumn | undefined {
  const s = unwrap(raw);
  const target = refsOf(def).find((r) => r.path === path && !r.usageOnly)?.target;
  const base = { path, label: def.labels?.[path] ?? fullLabel(path, Boolean(target)), required };
  if (s.type === 'object' && s.properties?.amountMinor && s.properties?.currencyId) return { ...base, kind: 'money' };
  if (s.type === 'array') {
    const item = unwrap(s.items ?? {});
    if (item.type === 'object') return undefined;
    if (target || item.pattern === OBJECT_ID) return target ? { ...base, kind: 'list', of: 'ref', target } : undefined;
    if (item.enum) return { ...base, kind: 'list', of: 'choice', choices: item.enum as string[], choiceNames: def.choiceLabels?.[path] };
    return { ...base, kind: 'list', of: 'text' };
  }
  if (target || s.pattern === OBJECT_ID) return target ? { ...base, kind: 'ref', target } : undefined;
  if (s.enum) return { ...base, kind: 'choice', choices: s.enum as string[], choiceNames: def.choiceLabels?.[path] };
  if (s.type === 'boolean') return { ...base, kind: 'boolean' };
  if (s.type === 'number' || s.type === 'integer') return { ...base, kind: 'number' };
  if (s.format === 'date' || s.format === 'date-time' || (raw.anyOf ?? []).some((o: Json) => o.format === 'date')) return { ...base, kind: 'date' };
  if (s.type === 'string') return { ...base, kind: 'text' };
  return undefined;
}

/** The columns a master can be imported with, in the schema's order; one level of nested fields becomes "parent.child". */
export function importColumns(def: MasterDefinition): ImportColumn[] {
  const schema = z.toJSONSchema(def.createSchema, { io: 'input', unrepresentable: 'any' }) as Json;
  const required = new Set<string>(schema.required ?? []);
  const out: ImportColumn[] = [];
  for (const [key, raw] of Object.entries((schema.properties ?? {}) as Record<string, Json>)) {
    if (SKIP.has(key)) continue;
    const s = unwrap(raw);
    if (s.type === 'object' && !(s.properties?.amountMinor && s.properties?.currencyId)) {
      const inner = new Set<string>(s.required ?? []);
      for (const [child, childRaw] of Object.entries((s.properties ?? {}) as Record<string, Json>)) {
        const c = columnFor(def, `${key}.${child}`, childRaw, required.has(key) && inner.has(child));
        if (c && c.kind !== 'list') out.push(c);
      }
      continue;
    }
    const c = columnFor(def, key, raw, required.has(key));
    if (c) out.push(c);
  }
  return out;
}

/**
 * The columns as this company has shaped the master (#65): its names, its required fields, its choice names, and
 * without the fields it hid or kept out of import. `aliases` keeps the code's own names, so older sheets still load.
 */
/** A company field as an import column (#97): the same kinds as built-in fields. Files are added on the record. */
function companyColumn(f: DynamicField): ImportColumn | undefined {
  const base = { path: `custom.${f.key}`, label: f.label, required: Boolean(f.required) };
  switch (f.type) {
    case 'number': return { ...base, kind: 'number' };
    case 'boolean': return { ...base, kind: 'boolean' };
    case 'date': return { ...base, kind: 'date' };
    case 'select': return { ...base, kind: 'choice', choices: f.options ?? [] };
    case 'multi_select': return { ...base, kind: 'list', of: 'choice', choices: f.options ?? [] };
    case 'reference': return f.referenceMaster ? { ...base, kind: 'ref', target: f.referenceMaster } : undefined;
    case 'image': case 'document': case 'files': return undefined;
    default: return { ...base, kind: 'text' };
  }
}

/** Company fields a spreadsheet can't hold: files are added on each record. The template and the dialog name them. */
export async function leftOutOfImport(def: MasterDefinition) {
  if (def.customFields === false) return [];
  return (await companyFieldsOf(def.key)).filter((f) => isFileType(f.type)).map((f) => ({ label: f.label, reason: 'Files are added on the record, not by import' }));
}

export async function companyColumns(def: MasterDefinition): Promise<(ImportColumn & { aliases: string[] })[]> {
  const layout = await getLayout(def.key);
  const own = def.customFields === false ? [] : (await companyFieldsOf(def.key)).map(companyColumn).filter((c): c is ImportColumn => Boolean(c));
  const byPath = new Map(layout.fields.map((f) => [f.path, f]));
  const choices = new Map(layout.choices.map((c) => [c.path, c.values]));
  const fixed = systemRequired(def);
  return [...importColumns(def), ...own]
    .filter((c) => { const l = byPath.get(c.path); return fixed.has(c.path) || !(l?.hidden || l?.inImport === false); })
    .map((c) => {
      const l = byPath.get(c.path);
      const named = choices.get(c.path)?.filter((v) => v.label);
      return {
        ...c,
        label: l?.label ?? c.label,
        required: c.required || Boolean(l?.required),
        aliases: l?.label && l.label !== c.label ? [c.label] : [],
        ...(named?.length ? { choiceNames: { ...(c.choiceNames ?? {}), ...Object.fromEntries(named.map((v) => [v.value, v.label!])) } } : {}),
      };
    });
}

export function importableMaster(key: string): MasterDefinition {
  const def = getMaster(key);
  if (!def) throw new NotFoundError(`No master "${key}"`);
  if (def.managed?.create) throw new ConflictError(`${def.label} are created through their own screen, not by import`);
  return def;
}

/** A CSV header line for the master: the columns' labels, quoted where needed. */
export async function templateCsv(def: MasterDefinition) {
  const cell = (v: string) => (/[",;\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  // A file field gets a column that says where it goes instead; the import leaves any column it doesn't know.
  const notes = (await leftOutOfImport(def)).map((f) => cell(`${f.label} (add on the record)`));
  return `${[...(await companyColumns(def)).map((c) => cell(`${c.label}${c.required ? ' *' : ''}`)), ...notes].join(',')}\r\n`;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Finds referenced records by code, name (the master's title field) or id, case-insensitively; cached per call. */
function referenceFinder() {
  const cache = new Map<string, string | null>();
  return async (target: string, text: string): Promise<string | null> => {
    const key = `${target}:${text.toLowerCase()}`;
    if (cache.has(key)) return cache.get(key)!;
    const t = getRefTarget(target);
    if (!t) return null;
    const exact = new RegExp(`^${escape(text)}$`, 'i');
    const or: Plain[] = [{ [t.titleField]: exact }];
    if (t.model.schema.path('code')) or.push({ code: exact });
    if (/^[0-9a-fA-F]{24}$/.test(text)) or.push({ _id: text });
    const found = await t.model.find({ $or: or }).select('_id').limit(2).lean();
    const id = found.length === 1 ? String(found[0]!._id) : null;
    cache.set(key, id);
    return id;
  };
}

const setPath = (obj: Plain, path: string, value: unknown) => {
  const parts = path.split('.');
  let at: Plain = obj;
  for (const p of parts.slice(0, -1)) at = (at[p] ??= {}) as Plain;
  at[parts.at(-1)!] = value;
};

/** "2026-11-04", "04/11/2026" or "4/11/2026" (day first, as the client's sheets are written) → YYYY-MM-DD. */
function toDate(text: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

async function convert(columns: ImportColumn[], row: Record<string, string>, find: ReturnType<typeof referenceFinder>, currencyOf: (code?: string) => Promise<{ id: string; minorUnits: number } | null>) {
  const data: Plain = {};
  const problems: { column: string; message: string }[] = [];
  for (const c of columns) {
    const text = (row[c.path] ?? '').trim();
    if (!text) continue;
    const bad = (message: string) => problems.push({ column: c.label, message });
    switch (c.kind) {
      case 'text': setPath(data, c.path, text); break;
      case 'number': {
        const n = Number(text.replace(/[\s,]/g, ''));
        if (Number.isFinite(n)) setPath(data, c.path, n); else bad(`"${text}" is not a number`);
        break;
      }
      case 'boolean': {
        const v = text.toLowerCase();
        if (['yes', 'y', 'true', '1'].includes(v)) setPath(data, c.path, true);
        else if (['no', 'n', 'false', '0'].includes(v)) setPath(data, c.path, false);
        else bad(`"${text}" should be yes or no`);
        break;
      }
      case 'date': {
        const d = toDate(text);
        if (d) setPath(data, c.path, d); else bad(`"${text}" is not a date (use YYYY-MM-DD or DD/MM/YYYY)`);
        break;
      }
      case 'choice': {
        const hit = pickChoice(c, text);
        if (hit) setPath(data, c.path, hit); else bad(`"${text}" isn't one of: ${choiceList(c)}`);
        break;
      }
      case 'ref': {
        const id = await find(c.target!, text);
        if (id) setPath(data, c.path, id); else bad(`No ${c.label.toLowerCase()} "${text}" (give its code or exact name)`);
        break;
      }
      case 'list': {
        const parts = text.split(/[;|]/).map((p) => p.trim()).filter(Boolean);
        const values: string[] = [];
        for (const p of parts) {
          if (c.of === 'ref') { const id = await find(c.target!, p); if (id) values.push(id); else bad(`No ${c.label.toLowerCase()} "${p}"`); }
          else if (c.of === 'choice') { const hit = pickChoice(c, p); if (hit) values.push(hit); else bad(`"${p}" isn't one of: ${choiceList(c)}`); }
          else values.push(p);
        }
        setPath(data, c.path, values);
        break;
      }
      case 'money': {
        // "250", "250 ZMW" or "USD 60": the amount, and the currency (the base currency when none is given).
        const m = /^([A-Za-z]{3})?\s*([\d\s,.]+)\s*([A-Za-z]{3})?$/.exec(text);
        const amount = m ? Number(m[2]!.replace(/[\s,]/g, '')) : Number.NaN;
        const currency = await currencyOf(m?.[1] ?? m?.[3]);
        if (!Number.isFinite(amount)) bad(`"${text}" is not an amount`);
        else if (!currency) bad(`Unknown currency in "${text}"`);
        else setPath(data, c.path, { amountMinor: Math.round(amount * 10 ** currency.minorUnits), currencyId: currency.id });
        break;
      }
    }
  }
  return { data, problems };
}

/**
 * Checks (dry run) or loads rows. Rows are objects keyed by column path or label, as read from the sheet.
 * A row whose code already exists is "exists", never a duplicate; nothing half-saved when a row fails.
 */
export async function importRows(def: MasterDefinition, rows: Record<string, string>[], options: { dryRun: boolean; firstRow?: number; baseCurrencyId?: string }, ctx: ServiceContext): Promise<RowResult[]> {
  const columns = await companyColumns(def);
  const byHeader = new Map<string, string>();
  for (const c of columns) for (const name of [c.path, c.label, ...c.aliases]) byHeader.set(normal(name), c.path);
  const find = referenceFinder();
  const currencies = getRefTarget('currencies');
  const currencyCache = new Map<string, { id: string; minorUnits: number } | null>();
  const currencyOf = async (code?: string) => {
    const k = (code ?? '').toUpperCase();
    if (currencyCache.has(k)) return currencyCache.get(k)!;
    const filter = k ? { code: k } : options.baseCurrencyId ? { _id: options.baseCurrencyId } : null;
    const doc = currencies && filter ? await currencies.model.findOne(filter).select('_id minorUnits').lean<{ _id: unknown; minorUnits?: number }>() : null;
    const value = doc ? { id: String(doc._id), minorUnits: Number(doc.minorUnits ?? 2) } : null;
    currencyCache.set(k, value);
    return value;
  };
  const hasCode = Boolean(def.model.schema.path('code'));
  const seenCodes = new Set<string>();
  const results: RowResult[] = [];
  const first = options.firstRow ?? 2;
  for (const [i, raw] of rows.entries()) {
    const row: Record<string, string> = {};
    for (const [header, value] of Object.entries(raw)) {
      const path = byHeader.get(normal(header.replace(/\*$/, '')));
      if (path) row[path] = String(value ?? '');
    }
    const result: RowResult = { row: first + i, status: 'ready', problems: [] };
    results.push(result);
    if (Object.values(row).every((v) => !v.trim())) { result.status = 'invalid'; result.problems.push({ column: '—', message: 'Empty row' }); continue; }
    const { data, problems } = await convert(columns, row, find, currencyOf);
    result.problems.push(...problems);
    const parsed = def.createSchema.safeParse(data);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = issue.path.join('.');
        const column = columns.find((c) => c.path === path || path.startsWith(`${c.path}.`))?.label ?? path;
        const message = issue.code === 'invalid_type' && issue.input === undefined ? 'Required' : issue.message;
        if (!result.problems.some((p) => p.column === column)) result.problems.push({ column, message });
      }
    }
    if (result.problems.length) { result.status = 'invalid'; continue; }
    if (hasCode && data.code) {
      const code = String(data.code).toUpperCase();
      if (seenCodes.has(code)) { result.status = 'invalid'; result.problems.push({ column: 'Code', message: `Code ${data.code} appears twice in the file` }); continue; }
      seenCodes.add(code);
      if (await def.model.exists({ code: new RegExp(`^${escape(String(data.code))}$`, 'i') })) { result.status = 'exists'; continue; }
    }
    if (options.dryRun || !parsed.success) continue;
    try {
      const created = await create(def, parsed.data as Plain, ctx);
      result.status = 'created';
      result.id = String(created.id);
    } catch (err) {
      result.status = 'failed';
      const e = err as { message?: string; details?: Record<string, unknown> };
      const detail = e.details && typeof e.details === 'object' ? Object.entries(e.details).map(([k, v]) => `${fullLabel(k)}: ${Array.isArray(v) ? v.join(', ') : String(v)}`).join('; ') : '';
      result.problems.push({ column: '—', message: [e.message, detail].filter(Boolean).join(' · ') });
    }
  }
  return results;
}
