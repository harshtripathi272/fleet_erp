import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { env } from '../../config/env.js';
import { ConflictError } from '../../core/errors/index.js';
import { logger } from '../../core/logger/index.js';
import { importRows, importableMaster, MAX_ROWS } from '../../core/masters/import.js';
import { getMaster } from '../../core/masters/registry.js';
import * as MasterService from '../../core/masters/service.js';
import type { Plain } from '../../core/masters/types.js';
import { ensureFirstOwner } from '../auth/auth.service.js';
import { SystemState } from '../auth/systemState.model.js';
import { Company } from '../company/company.model.js';
import { saveCompanySchema } from '../company/company.schema.js';
import { saveCompany } from '../company/company.service.js';
import { fetchRates, saveFeedSettings } from '../finance/rateFeed.service.js';
import { saveLayout } from '../../core/masters/layout.js';
import { CustomMaster, FieldDefinition, List } from '../configuration/models/configuration.model.js';
import { customMasterDefinition, fieldDefinitionDefinition, listDefinition } from '../configuration/configuration.service.js';
import { createCustomMasterSchema, createFieldDefinitionSchema, createListSchema, updateCustomMasterSchema, updateFieldDefinitionSchema, updateListSchema } from '../configuration/configuration.schema.js';
import { restoreSnapshot } from './snapshot.js';
import { Connection } from '../connections/connection.model.js';
import { type ConnectionRule, connectionDefinition, connectionRules, createConnectionSchema, saveConnectionRules, updateConnectionSchema } from '../connections/connections.service.js';
import * as Files from '../files/files.service.js';
import { loadSampleData } from '../meta/sampleData.js';
import { loadStarterLists } from '../meta/starterLists.js';
import { Role } from '../roles/role.model.js';
import { roleDefinition, systemRoles } from '../roles/roles.service.js';
import { createRoleSchema, updateRoleSchema } from '../roles/roles.schema.js';
import { User } from '../users/user.model.js';
import { createUser, userDefinition } from '../users/users.service.js';
import { createUserSchema, updateUserSchema } from '../users/users.schema.js';
import { BRAND_FILES, type BrandFile, type CompanyFile, companyFileSchema } from './companyFile.js';
import { readCsv } from './csv.js';

/**
 * Applies a company file on start-up (#76): COMPANY_CONFIG names it, and the files it lists sit next to it.
 *
 * What was applied is kept. The next start compares the file with that, not with the database, and sets
 * only what the file changed: a setting someone has since changed in the app keeps its value unless the
 * file changes that same setting again. Records are found by their code, key or e-mail and created when
 * missing; nothing is ever deleted, and a data row already there is left alone, as the import screen does.
 */
const STATE_KEY = 'company-file';
const LOCK_KEY = 'company-file-applying';
const LOCK_MS = 10 * 60_000;

interface Applied { file: CompanyFile; hash: string; hashes: Record<string, string>; at: string; results: Result[] }
export interface Result { step: string; outcome: 'created' | 'updated' | 'unchanged' | 'skipped' | 'failed'; detail?: string }

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const system = { actorId: undefined, canSeeSensitive: true };

/** Reads and checks a company file; the error names each problem with its place in the file. */
export async function readCompanyFile(path: string): Promise<{ file: CompanyFile; raw: string }> {
  const raw = await readFile(path, 'utf8');
  let json: unknown;
  try { json = JSON.parse(raw); } catch (err) { throw new Error(`${path} is not valid JSON: ${(err as Error).message}`); }
  const parsed = companyFileSchema.safeParse(json);
  if (!parsed.success) throw new Error(`${path} is not a valid company file:\n${parsed.error.issues.map((i) => `  ${i.path.join('.') || '(file)'}: ${i.message}`).join('\n')}`);
  return { file: parsed.data, raw };
}

/** What was last applied, for the set-up screen. */
/** The whole company file this copy last applied, for resetting a demonstration and previewing a new file. */
export async function lastAppliedFile(): Promise<CompanyFile | undefined> {
  return (await SystemState.findOne({ key: STATE_KEY }).lean<{ value?: Applied }>())?.value?.file;
}

export async function lastApplied() {
  const state = await SystemState.findOne({ key: STATE_KEY }).lean<{ value?: Applied }>();
  return state?.value ? { at: state.value.at, hash: state.value.hash, company: state.value.file.company.key, purpose: state.value.file.purpose ?? 'real', results: state.value.results } : null;
}

export async function applyCompanyFile(path: string): Promise<{ applied: boolean; results: Result[] }> {
  const { file, raw } = await readCompanyFile(path);
  const dir = dirname(path);
  return applyFile(file, raw, (name) => readFile(join(dir, name)));
}

/** How a person's set-up differs from a start-up: who is watching, and who is already signed in. */
export interface ApplyOptions {
  /** Told of each step as it finishes, so the screen can show it happening. */
  onResult?: (result: Result) => void;
  /** More owners can be added once the copy has its first: the set-up invites one named there. */
  inviteOwner?: boolean;
}

/** Applies a checked company file. `read` finds the files it names, on disk at start-up or in the set-up's draft. */
export async function applyFile(file: CompanyFile, raw: string, read: (name: string) => Promise<Buffer>, options: ApplyOptions = {}): Promise<{ applied: boolean; results: Result[] }> {
  // Data and brand files count towards "changed", so a new spreadsheet next to the same company file is applied.
  const hashes: Record<string, string> = {};
  for (const f of file.data.files) hashes[f.file] = sha(await read(f.file));
  for (const name of Object.values(file.brand.files)) if (name) hashes[name] = sha(await read(name));
  if (file.data.snapshot) hashes[file.data.snapshot] = sha(await read(file.data.snapshot));
  const hash = sha(JSON.stringify([raw, hashes]));

  const state = await SystemState.findOne({ key: STATE_KEY }).lean<{ value?: Applied }>();
  const last = state?.value;
  if (last?.hash === hash) return { applied: false, results: [] };
  if (!(await lock())) { logger.info({}, 'Another instance is applying the company file'); return { applied: false, results: [] }; }

  const results: Result[] = [];
  const note = (step: string, outcome: Result['outcome'], detail?: string) => {
    results.push({ step, outcome, detail });
    options.onResult?.({ step, outcome, detail });
    (outcome === 'failed' ? logger.warn.bind(logger) : logger.info.bind(logger))({ step, outcome, detail }, 'Company file');
  };
  /** True the first time, or when the file's value differs from what was applied last. */
  const changed = (pick: (f: CompanyFile) => unknown) => !last || !isDeepStrictEqual(pick(file), pick(last.file));
  try {
    await details(file, changed, note);
    await sample(file, last, note);
    await snapshot(file, last, hashes, read, note);
    // After the sample, whose records don't know a company's required fields; before the spreadsheets, which may use them.
    await mastersStep(file, last, note);
    await data(file, last, hashes, read, note);
    await regionRecords(file, note);
    await settings(file, changed, note);
    // After the settings: the lists use the company's base currency.
    await starter(file, last, note);
    await roles(file, last, note);
    await connections(file, last, note);
    await rates(file, note);
    await rulesStep(file, changed, note, options);
    // E-mail is set up by now, so the invitations carry the company's brand and go out over its server.
    await people(file, last, note, options);
    await brandFiles(file, last, hashes, read, note);
    await SystemState.updateOne({ key: STATE_KEY }, { $set: { value: { file, hash, hashes, at: new Date().toISOString(), results } satisfies Applied } }, { upsert: true });
  } finally {
    await SystemState.deleteOne({ key: LOCK_KEY });
  }
  logger.info({ company: file.company.key, changes: results.filter((r) => r.outcome !== 'unchanged').length }, 'Company file applied');
  return { applied: true, results };
}

async function lock() {
  await SystemState.deleteOne({ key: LOCK_KEY, updatedAt: { $lt: new Date(Date.now() - LOCK_MS) } });
  try { await SystemState.create({ key: LOCK_KEY, value: true }); return true; } catch { return false; }
}

type Note = (step: string, outcome: Result['outcome'], detail?: string) => void;
type Changed = (pick: (f: CompanyFile) => unknown) => boolean;

/** The company record first: the sample data would otherwise bring its own company. */
async function details(file: CompanyFile, changed: Changed, note: Note) {
  const existing = await Company.findOne().lean<Plain>();
  const { key: _key, ...fields } = file.company;
  if (!existing) {
    await saveCompany(saveCompanySchema.parse(fields));
    return note('company', 'created', file.company.legalName);
  }
  const patch = Object.fromEntries(Object.entries(fields).filter(([k]) => changed((f) => (f.company as Plain)[k])));
  if (!Object.keys(patch).length) return note('company', 'unchanged');
  await saveCompany(saveCompanySchema.parse({ ...patch, version: existing.version }));
  note('company', 'updated', Object.keys(patch).join(', '));
}

async function sample(file: CompanyFile, last: Applied | undefined, note: Note) {
  if (file.data.sample === 'none' || file.data.sample === 'starter' || (last && last.file.data.sample !== 'none')) return;
  try {
    const { created } = await loadSampleData(undefined, file.data.sample);
    note('sample data', 'created', `${created} records`);
  } catch (err) {
    if (err instanceof ConflictError) note('sample data', 'skipped', err.message);
    else throw err;
  }
}

/** The usual lists, the first time the file asks for them. A list the company already has is left alone. */
async function starter(file: CompanyFile, last: Applied | undefined, note: Note) {
  if (file.data.sample !== 'starter' || last?.file.data.sample === 'starter') return;
  try {
    const { created, existing, failed } = await loadStarterLists();
    note('usual lists', failed.length ? 'failed' : 'created', [`${created} records`, existing ? `${existing} already there` : '', ...failed].filter(Boolean).join('; '));
  } catch (err) { note('usual lists', 'failed', (err as Error).message); }
}

/** Each data file once, and again only when it changes: rows already there are left as they are. */
async function data(file: CompanyFile, last: Applied | undefined, hashes: Record<string, string>, read: (n: string) => Promise<Buffer>, note: Note) {
  const company = await Company.findOne().select('baseCurrencyId').lean<{ baseCurrencyId?: unknown }>();
  for (const { master, file: name } of file.data.files) {
    const step = `data ${name}`;
    if (last?.hashes[name] === hashes[name]) { note(step, 'unchanged'); continue; }
    let def;
    try { def = importableMaster(master); } catch (err) { note(step, 'failed', (err as Error).message); continue; }
    const rows = readCsv((await read(name)).toString('utf8'));
    const counts = { created: 0, exists: 0, failed: 0 };
    const problems: string[] = [];
    for (let start = 0; start < rows.length; start += MAX_ROWS) {
      const results = await importRows(def, rows.slice(start, start + MAX_ROWS), { dryRun: false, firstRow: start + 2, baseCurrencyId: company?.baseCurrencyId ? String(company.baseCurrencyId) : undefined }, system);
      for (const r of results) {
        if (r.status === 'created') counts.created++;
        else if (r.status === 'exists') counts.exists++;
        else { counts.failed++; if (problems.length < 5) problems.push(`row ${r.row}: ${r.problems?.map((p) => p.message).join('; ')}`); }
      }
    }
    const detail = `${counts.created} added, ${counts.exists} already there${counts.failed ? `, ${counts.failed} refused (${problems.join(' · ')})` : ''}`;
    note(step, counts.failed && !counts.created ? 'failed' : counts.created ? 'created' : 'unchanged', detail);
  }
}

const idByCode = async (master: string, code: string | undefined) => {
  if (!code) return undefined;
  const doc = await getMaster(master)?.model.findOne({ code, status: 'active' }).select('_id').lean<{ _id: unknown }>();
  return doc ? String(doc._id) : null;
};

/** The company's own records, as they stood where it was packaged. Once, and again only if the package's copy changes. */
async function snapshot(file: CompanyFile, last: Applied | undefined, hashes: Record<string, string>, read: (n: string) => Promise<Buffer>, note: Note) {
  const name = file.data.snapshot;
  if (!name) return;
  if (last?.hashes[name] === hashes[name]) return note('records', 'unchanged');
  const done = await restoreSnapshot(await read(name), read);
  note('records', 'created', `${done.records} records${done.files ? ` and ${done.files} files` : ''}`);
}

/**
 * The masters as this company shapes them: its lists, its own masters, its own fields, then each master's layout.
 * Found by code or key, so the same file can be applied again; a failure in one doesn't stop the rest.
 */
async function mastersStep(file: CompanyFile, last: Applied | undefined, note: Note) {
  const m = file.masters;
  if (!m) return;
  const before = last?.file.masters;
  await upsert({
    step: 'list', list: m.lists as Plain[], before: before?.lists as Plain[] | undefined, keyOf: (l) => String(l.code), note,
    find: (code) => List.findOne({ code }).lean<Plain>(),
    create: (l) => MasterService.create(listDefinition, createListSchema.parse(l) as Plain, system),
    update: (doc, changes) => MasterService.update(listDefinition, String(doc._id), updateListSchema.parse({ ...changes, version: doc.version }) as Plain, system),
  });
  // A field's list is named by code in the file; here it needs the list's id.
  const lists = new Map((await List.find().select('code').lean<{ _id: unknown; code: string }[]>()).map((l) => [l.code, String(l._id)]));
  const withList = <T extends { listCode?: string }>(f: T) => {
    const { listCode, ...rest } = f;
    return { ...rest, ...(listCode && lists.has(listCode) ? { listId: lists.get(listCode) } : {}) } as Plain;
  };
  await upsert({
    step: 'master', list: m.customMasters as Plain[], before: before?.customMasters as Plain[] | undefined, keyOf: (x) => String(x.code), note,
    find: (code) => CustomMaster.findOne({ code }).lean<Plain>(),
    create: (x) => MasterService.create(customMasterDefinition, createCustomMasterSchema.parse({ ...x, fields: (x.fields as Plain[]).map(withList) }) as Plain, system),
    update: (doc, changes) => MasterService.update(customMasterDefinition, String(doc._id), updateCustomMasterSchema.parse({ ...changes, ...(changes.fields ? { fields: (changes.fields as Plain[]).map(withList) } : {}), version: doc.version }) as Plain, system),
  });
  await upsert({
    step: 'field', list: m.fields as Plain[], before: before?.fields as Plain[] | undefined, keyOf: (f) => `${String(f.entity)}.${String(f.key)}`, note,
    find: (key) => { const at = key.indexOf('.'); return FieldDefinition.findOne({ entity: key.slice(0, at), key: key.slice(at + 1) }).lean<Plain>(); },
    create: (f) => MasterService.create(fieldDefinitionDefinition, createFieldDefinitionSchema.parse(withList(f as { listCode?: string })) as Plain, system),
    update: (doc, changes) => MasterService.update(fieldDefinitionDefinition, String(doc._id), updateFieldDefinitionSchema.parse({ ...withList(changes as { listCode?: string }), version: doc.version }) as Plain, system),
  });
  for (const layout of m.layouts) {
    const { entity, ...input } = layout;
    const was = before?.layouts.find((l) => l.entity === entity);
    if (was && isDeepStrictEqual(was, layout)) continue;
    const def = getMaster(entity);
    if (!def) { note(`layout ${entity}`, 'failed', `No master "${entity}"`); continue; }
    try {
      await saveLayout(def, input, {});
      note(`layout ${entity}`, 'updated', def.label);
    } catch (err) { note(`layout ${entity}`, 'failed', (err as Error).message); }
  }
}

/**
 * What this company may change later. A real company's own copy takes these only from the file it starts with: its
 * owner re-running the set-up there can't lift a lock that was put on it.
 */
async function rulesStep(file: CompanyFile, changed: Changed, note: Note, options: ApplyOptions) {
  if (!changed((f) => f.connectionRules)) return;
  // Most companies have none, and "none" isn't news.
  if (!file.connectionRules && !Object.keys(await connectionRules()).length) return;
  if (options.inviteOwner && !env.SETUP_PACKAGES) return note('connection rules', 'skipped', "This copy's connection rules come from its company file");
  await saveConnectionRules((file.connectionRules ?? {}) as Record<string, ConnectionRule>);
  note('connection rules', 'updated');
}

/** The other currencies it works in, and their first live rates when a rate service is connected. */
async function rates(file: CompanyFile, note: Note) {
  const codes = (file.regional.currencies ?? []).filter((c) => c !== file.regional.baseCurrency);
  if (!codes.length) return;
  const def = getMaster('currencies')!;
  const ids: string[] = [];
  for (const code of codes) {
    let id = await idByCode('currencies', code);
    if (!id) {
      try {
        const made = await MasterService.create(def, def.createSchema.parse(currencyFromCode(code)) as Plain, system);
        id = String(made.id);
        note(`currency ${code}`, 'created');
      } catch (err) { note(`currency ${code}`, 'failed', (err as Error).message); continue; }
    }
    ids.push(id);
  }
  try {
    await saveFeedSettings({ currencyIds: ids });
    if (!file.connections.some((c) => c.kind === 'rates' && c.enabled)) return;
    const run = await fetchRates({ trigger: 'manual' }) as unknown as { outcome?: string; stored?: number; error?: string };
    if (run.outcome === 'stored') note('exchange rates', 'created', `Today's rates for ${codes.join(', ')}`);
    else note('exchange rates', 'failed', run.error ?? `The rate service answered: ${run.outcome ?? 'no rates'}. Rates can be fetched again from the exchange-rates screen.`);
  } catch (err) { note('exchange rates', 'failed', (err as Error).message); }
}

/** The company's country and currency as records, when neither the data files nor the sample data brought them. */
async function regionRecords(file: CompanyFile, note: Note) {
  const { country, baseCurrency, timezone, style } = file.regional;
  if (baseCurrency && !(await idByCode('currencies', baseCurrency))) {
    try {
      const def = getMaster('currencies')!;
      await MasterService.create(def, def.createSchema.parse(currencyFromCode(baseCurrency)) as Plain, system);
      note(`currency ${baseCurrency}`, 'created');
    } catch (err) { note(`currency ${baseCurrency}`, 'failed', (err as Error).message); }
  }
  if (country && !(await idByCode('countries', country))) {
    try {
      const def = getMaster('countries')!;
      const currencyId = baseCurrency ? await idByCode('currencies', baseCurrency) : undefined;
      await MasterService.create(def, def.createSchema.parse({
        code: country, name: new Intl.DisplayNames(['en'], { type: 'region' }).of(country) ?? country,
        ...(style?.phoneCountryCode ? { dialCode: style.phoneCountryCode } : {}),
        ...(timezone ? { timezones: [timezone] } : {}),
        ...(currencyId ? { currencyId } : {}),
      }) as Plain, system);
      note(`country ${country}`, 'created');
    } catch (err) { note(`country ${country}`, 'failed', (err as Error).message); }
  }
}

/** A currency's name, symbol and decimal places, from the runtime's own list. */
function currencyFromCode(code: string) {
  const format = new Intl.NumberFormat('en', { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' });
  return {
    code, name: new Intl.DisplayNames(['en'], { type: 'currency' }).of(code) ?? code,
    symbol: format.formatToParts(0).find((p) => p.type === 'currency')?.value.slice(0, 8) ?? code,
    minorUnits: Math.min(4, format.resolvedOptions().maximumFractionDigits ?? 2),
  };
}

/** Regional settings, brand, areas and the company's options: each one only when the file changed it. */
async function settings(file: CompanyFile, changed: Changed, note: Note) {
  const patch: Plain = {};
  const { country, baseCurrency, style, currencies: _currencies, ...regional } = file.regional;
  for (const [k, v] of Object.entries(regional)) if (v !== undefined && changed((f) => (f.regional as Plain)[k])) patch[k] = v;
  if (style && changed((f) => f.regional.style)) patch.regional = style;
  for (const [field, master, code] of [['countryId', 'countries', country], ['baseCurrencyId', 'currencies', baseCurrency]] as const) {
    if (!code || !changed((f) => (field === 'countryId' ? f.regional.country : f.regional.baseCurrency))) continue;
    const id = await idByCode(master, code);
    if (id) patch[field] = id;
    else note(`regional ${field === 'countryId' ? 'country' : 'base currency'}`, 'failed', `No ${master === 'countries' ? 'country' : 'currency'} with code ${code}: add it in the data files`);
  }
  const { files: _files, ...brandText } = file.brand;
  const brand: Plain = {};
  for (const [k, v] of Object.entries(brandText)) if (v !== undefined && changed((f) => (f.brand as Plain)[k])) brand[k] = v;
  if (Object.keys(brand).length) patch.brand = brand;
  if (file.watermark && changed((f) => f.watermark)) patch.watermark = file.watermark;
  if (file.operations && changed((f) => f.operations)) patch.operations = file.operations;
  if (file.maintenance && changed((f) => f.maintenance)) patch.maintenance = file.maintenance;
  for (const key of ['vocabulary', 'stages', 'desks'] as const) {
    const value = file.workspace?.[key];
    if (value !== undefined && changed((f) => f.workspace?.[key])) patch[key] = value;
  }
  if (file.areas && changed((f) => f.areas)) patch.modules = file.areas;
  if (changed((f) => f.selfSignUp)) patch.allowSelfRegistration = file.selfSignUp;
  if (!Object.keys(patch).length) return note('settings', 'unchanged');
  const existing = await Company.findOne().select('version').lean<{ version: number }>();
  await saveCompany(saveCompanySchema.parse({ ...patch, version: existing!.version }));
  note('settings', 'updated', Object.keys(patch).map((k) => (k === 'brand' ? `brand (${Object.keys(brand).join(', ')})` : k)).join(', '));
}

/** The logo and the other brand files, stored like any upload, in the owner's name. Each again only when it changes. */
async function brandFiles(file: CompanyFile, last: Applied | undefined, hashes: Record<string, string>, read: (n: string) => Promise<Buffer>, note: Note) {
  const ownerRole = await Role.findOne({ key: 'owner' }).select('_id').lean<{ _id: unknown }>();
  const owner = await User.findOne({ email: file.owner.email }).select('_id').lean<{ _id: unknown }>()
    ?? await User.findOne({ roleIds: ownerRole?._id, status: 'active' } as Plain).sort({ createdAt: 1 }).select('_id').lean<{ _id: unknown }>();
  const brand: Plain = {};
  for (const [slot, name] of Object.entries(file.brand.files) as [BrandFile, string | undefined][]) {
    if (!name || last?.hashes[name] === hashes[name]) continue;
    if (!owner) { note(`brand ${name}`, 'failed', 'No owner yet to store it for'); continue; }
    try {
      const stored = await Files.upload(await read(name), name.split('/').pop(), { userId: String(owner._id), can: () => true });
      brand[BRAND_FILES[slot]] = stored.id;
      note(`brand ${name}`, 'updated');
    } catch (err) { note(`brand ${name}`, 'failed', (err as Error).message); }
  }
  if (!Object.keys(brand).length) return;
  const existing = await Company.findOne().select('version').lean<{ version: number }>();
  await saveCompany(saveCompanySchema.parse({ brand, version: existing!.version }));
}

/**
 * Records found by a key: created when missing, otherwise only the fields the file changed since the last
 * start are sent. A record the file no longer lists is left as it is.
 */
async function upsert<T extends Plain>(opts: {
  step: string; list: T[]; before: T[] | undefined; keyOf: (item: T) => string;
  find: (key: string) => Promise<Plain | null>;
  create: (item: T) => Promise<unknown>; update: (doc: Plain, changes: Partial<T>) => Promise<unknown>; note: Note;
}) {
  for (const item of opts.list) {
    const key = opts.keyOf(item);
    const step = `${opts.step} ${key}`;
    try {
      const doc = await opts.find(key);
      if (!doc) { await opts.create(item); opts.note(step, 'created'); continue; }
      // New to the file: all of it. Listed before: what the file changed. Either way, not what the record already holds.
      const was = opts.before?.find((b) => opts.keyOf(b) === key);
      const changes = Object.fromEntries(Object.entries(item).filter(([k, v]) => (!was || !isDeepStrictEqual(v, was[k])) && !isDeepStrictEqual(v, doc[k]))) as Partial<T>;
      if (!Object.keys(changes).length) { opts.note(step, 'unchanged'); continue; }
      await opts.update(doc, changes);
      opts.note(step, 'updated', Object.keys(changes).join(', '));
    } catch (err) {
      opts.note(step, 'failed', (err as Error).message);
    }
  }
}

async function roles(file: CompanyFile, last: Applied | undefined, note: Note) {
  const builtIn = new Set(systemRoles().map((r) => r.key));
  const list = file.roles.filter((r) => {
    if (builtIn.has(r.key)) note(`role ${r.key}`, 'skipped', 'A built-in role: it comes with every installation and cannot be set from the file');
    return !builtIn.has(r.key);
  });
  await upsert({
    step: 'role', list, before: last?.file.roles, keyOf: (r) => r.key, note,
    find: (key) => Role.findOne({ key }).lean<Plain>(),
    create: (r) => MasterService.create(roleDefinition, createRoleSchema.parse(r) as Plain, system),
    update: (doc, changes) => MasterService.update(roleDefinition, String(doc._id), updateRoleSchema.parse({ ...changes, version: doc.version }) as Plain, system),
  });
}

async function connections(file: CompanyFile, last: Applied | undefined, note: Note) {
  // Switched off before switched on, so moving "in use" from one connection to another never meets two at once.
  const list = [...file.connections].sort((a, b) => Number(a.enabled) - Number(b.enabled));
  await upsert({
    step: 'connection', list, before: last?.file.connections, keyOf: (c) => c.code, note,
    find: (code) => Connection.findOne({ code }).lean<Plain>(),
    create: (c) => MasterService.create(connectionDefinition, createConnectionSchema.parse(c) as Plain, system),
    update: (doc, changes) => MasterService.update(connectionDefinition, String(doc._id), updateConnectionSchema.parse({ ...changes, version: doc.version }) as Plain, system),
  });
}

/** The first owner, then the staff, each invited by e-mail once. */
async function people(file: CompanyFile, last: Applied | undefined, note: Note, options: ApplyOptions = {}) {
  const { created, sent, passwordSet } = await ensureFirstOwner(file.owner.email);
  note('owner', created ? 'created' : 'unchanged', created ? `${file.owner.email}${passwordSet ? ', with the password from OWNER_PASSWORD' : sent ? ', invited' : ', invitation not sent: use "Forgot password"'}` : undefined);
  if (created && file.owner.name) await User.updateOne({ email: file.owner.email }, { $set: { name: file.owner.name } });
  if (options.inviteOwner && !created && !(await User.exists({ email: file.owner.email }))) {
    try {
      const role = await Role.findOne({ key: 'owner' }).select('_id').lean<{ _id: unknown }>();
      await createUser(createUserSchema.parse({ name: file.owner.name ?? file.owner.email.split('@')[0], email: file.owner.email, roleIds: [String(role!._id)] }) as Plain, system);
      note('owner', 'created', `${file.owner.email}, invited`);
    } catch (err) { note('owner', 'failed', (err as Error).message); }
  }
  const roleIds = async (keys: string[]) => {
    const found = await Role.find({ key: { $in: keys }, status: 'active' }).select('_id key').lean<{ _id: unknown; key: string }[]>();
    const missing = keys.filter((k) => !found.some((r) => r.key === k));
    if (missing.length) throw new Error(`No role ${missing.join(', ')}`);
    return found.map((r) => String(r._id));
  };
  await upsert({
    step: 'staff', list: file.staff, before: last?.file.staff, keyOf: (p) => p.email, note,
    find: (email) => User.findOne({ email }).lean<Plain>(),
    create: async (p) => createUser(createUserSchema.parse({ name: p.name ?? p.email.split('@')[0], email: p.email, phone: p.phone, roleIds: await roleIds(p.roles) }) as Plain, system),
    update: async (doc, changes) => MasterService.update(userDefinition, String(doc._id), updateUserSchema.parse({
      ...(changes.name ? { name: changes.name } : {}), ...(changes.phone ? { phone: changes.phone } : {}), ...(changes.roles ? { roleIds: await roleIds(changes.roles) } : {}), version: doc.version,
    }) as Plain, system),
  });
}
