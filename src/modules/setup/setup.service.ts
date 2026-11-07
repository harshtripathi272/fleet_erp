import { randomInt } from 'node:crypto';
import mongoose from 'mongoose';
import { MAX_ROWS, companyColumns, importRows, importableMaster } from '../../core/masters/import.js';
import { readCsv } from './csv.js';
import { env } from '../../config/env.js';
import { ForbiddenError, ValidationError } from '../../core/errors/index.js';
import { listMasters } from '../../core/masters/registry.js';
import { storeOf } from '../../core/storage/index.js';
import type { Plain } from '../../core/masters/types.js';
import { getMaster, refsOf } from '../../core/masters/registry.js';
import { SystemState } from '../auth/systemState.model.js';
import { Company } from '../company/company.model.js';
import { Connection } from '../connections/connection.model.js';
import { connectionRules } from '../connections/connections.service.js';
import { RecordLayout } from '../../core/masters/layout.js';
import { contextFor, providerFor, type Provider } from '../../core/connections/index.js';
import { CustomMaster, FieldDefinition, List } from '../configuration/models/configuration.model.js';
import { Driver } from '../drivers/models/driver.model.js';
import { StoredFile } from '../files/file.model.js';
import { Role } from '../roles/role.model.js';
import * as DriverAccess from '../users/driverAccess.service.js';
import { User } from '../users/user.model.js';
import { createUser } from '../users/users.service.js';
import { type Result, applyFile, lastApplied } from './apply.js';
import { TARGET_FIELDS, TARGET_NEEDS, deployGuide } from './guide.js';
import { type RecordsLevel, buildSnapshot, snapshotSummary } from './snapshot.js';
import { BRAND_FILES, COMPANY_FILE_FORMAT, type CompanyFile, type CompanyFileInput, TARGETS, companyFileSchema } from './companyFile.js';
import { TARGET_LABEL, TARGET_STATE, TESTED_TARGETS, buildKit, checkKit, kitName } from './kit.js';

/**
 * The Company kit screen (#76). It starts from this installation, where the company was set up on the usual
 * screens, and adds what only a deployment needs: the owner, the staff, the data files and where it runs.
 */

/** A short name for resource names, from the company's name: "Acme Haulage Ltd" → acme-haulage-ltd. */
const keyOf = (name: string) => {
  const key = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '');
  return /^[a-z]/.test(key) && key.length >= 3 ? key : `co-${key}`.slice(0, 24);
};
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const codeOf = async (master: string, id: unknown) => (id ? (await getMaster(master)?.model.findById(id).select('code').lean<{ code?: string }>())?.code : undefined);
const defined = <T extends Plain>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as T;

/** This installation as a company file: details, regional settings, brand and its files, areas, connections, roles. */
export async function fromInstallation(): Promise<{ file: CompanyFileInput; attachments: Attachment[] }> {
  const c = (await Company.findOne().lean<Plain>()) ?? {};
  const legalName = String(c.legalName ?? '');
  const attachments: Attachment[] = [];
  const brand = (c.brand ?? {}) as Plain;
  const files: Record<string, string> = {};
  for (const [slot, field] of Object.entries(BRAND_FILES)) {
    if (!brand[field]) continue;
    const stored = await StoredFile.findById(brand[field]).select('key mime connectionId').lean<{ key: string; mime: string; connectionId?: unknown }>();
    if (!stored || !EXT[stored.mime]) continue;
    const chunks: Buffer[] = [];
    for await (const chunk of await (await storeOf(stored)).open(stored.key)) chunks.push(Buffer.from(chunk as Buffer));
    const path = `files/${slot}.${EXT[stored.mime]}`;
    attachments.push({ path, data: Buffer.concat(chunks).toString('base64') });
    files[slot] = path;
  }
  const { logoFileId: _a, logoDarkFileId: _b, iconFileId: _c, logoPdfFileId: _d, ...brandText } = brand;
  const connections = await Connection.find({ status: 'active' }).sort({ kind: 1, code: 1 }).lean<Plain[]>();
  const roles = await Role.find({ isSystem: { $ne: true }, status: 'active' }).sort({ key: 1 }).lean<Plain[]>();
  const [layouts, listDocs, fieldDocs, customDocs] = await Promise.all([
    RecordLayout.find().lean<Plain[]>(), List.find({ status: 'active' }).lean<Plain[]>(), FieldDefinition.find({ status: 'active' }).sort({ entity: 1, order: 1 }).lean<Plain[]>(), CustomMaster.find({ status: 'active' }).lean<Plain[]>(),
  ]);
  const listCode = new Map(listDocs.map((l) => [String(l._id), String(l.code)]));
  const spec = (f: Plain) => defined({
    key: f.key, label: f.label, type: f.type, required: f.required || undefined, options: f.options, referenceMaster: f.referenceMaster, min: f.min, max: f.max,
    maxLength: f.maxLength, pattern: f.pattern, helpText: f.helpText, order: f.order,
    maxSizeMb: f.maxSizeMb, maxFiles: f.maxFiles, accept: f.accept, withExpiry: f.withExpiry, listCode: f.listId ? listCode.get(String(f.listId)) : undefined,
  });
  const ownerRole = await Role.findOne({ key: 'owner' }).select('_id').lean<{ _id: unknown }>();
  const people = await User.find({ status: 'active', driverId: null }).sort({ createdAt: 1 }).select('name email phone roleIds').lean<Plain[]>();
  const roleKey = new Map((await Role.find().select('key').lean<Plain[]>()).map((r) => [String(r._id), String(r.key)]));
  const firstOwner = people.find((p) => ((p.roleIds ?? []) as unknown[]).some((id) => String(id) === String(ownerRole?._id)));
  const rateFeed = (c.rateFeed ?? {}) as { currencyIds?: unknown[] };
  const rateCodes = rateFeed.currencyIds?.length ? await Promise.all(rateFeed.currencyIds.map((id) => codeOf('currencies', id))) : [];
  const file: CompanyFileInput = {
    format: COMPANY_FILE_FORMAT,
    company: defined({
      key: keyOf(String(c.tradingName ?? legalName) || 'company'), legalName,
      tradingName: c.tradingName, registrationNumber: c.registrationNumber, taxId: c.taxId,
      address: c.address, phone: c.phone, email: c.email, website: c.website,
    }) as CompanyFileInput['company'],
    regional: defined({
      country: await codeOf('countries', c.countryId), baseCurrency: await codeOf('currencies', c.baseCurrencyId),
      timezone: c.timezone, dateFormat: c.dateFormat, fiscalYearStartMonth: c.fiscalYearStartMonth,
      style: c.regional, currencies: rateCodes.filter(Boolean).length ? rateCodes.filter(Boolean) : undefined,
    }) as CompanyFileInput['regional'],
    brand: { ...defined(brandText), files },
    watermark: c.watermark as CompanyFileInput['watermark'],
    areas: c.modules as CompanyFileInput['areas'],
    operations: c.operations as CompanyFileInput['operations'],
    selfSignUp: Boolean(c.allowSelfRegistration),
    connections: connections.map((x) => defined({
      code: x.code, name: x.name, description: x.description, kind: x.kind, provider: x.provider, enabled: Boolean(x.enabled),
      settings: x.settings ?? {}, secrets: x.secrets ?? {}, webhookSecretEnv: x.webhookSecretEnv,
    })) as CompanyFileInput['connections'],
    roles: roles.map((r) => defined({ key: r.key, name: r.name, description: r.description, permissions: ((r.permissions ?? []) as Plain[]).map((p) => ({ resource: p.resource, actions: p.actions })) })) as CompanyFileInput['roles'],
    owner: { email: env.OWNER_EMAIL ?? String(firstOwner?.email ?? ''), ...(firstOwner?.name ? { name: String(firstOwner.name) } : {}) },
    // Everyone at a desk, except the demonstration's own sign-ins.
    staff: people.filter((p) => p !== firstOwner && !String(p.email).endsWith('.test') && p.email).map((p) => defined({
      name: p.name, email: p.email, phone: p.phone, roles: ((p.roleIds ?? []) as unknown[]).map((id) => roleKey.get(String(id))).filter(Boolean),
    })) as CompanyFileInput['staff'],
    data: { sample: 'none', files: [] },
    deploy: { target: 'compose' },
    purpose: (await lastApplied())?.purpose ?? 'real',
    connectionRules: Object.keys(await connectionRules()).length ? await connectionRules() as CompanyFileInput['connectionRules'] : undefined,
    masters: {
      layouts: layouts.map((l) => ({ entity: l.entity, master: l.master ?? {}, sections: l.sections ?? [], fields: l.fields ?? [], choices: l.choices ?? [] })),
      lists: listDocs.map((l) => defined({ code: l.code, name: l.name, description: l.description, values: ((l.values ?? []) as Plain[]).map((v) => defined({ value: v.value, label: v.label, order: v.order, active: v.active })) })),
      fields: fieldDocs.map((f) => defined({ entity: f.entity, ...spec(f), placement: f.placement, askedOf: f.askedOf, printOn: f.printOn })),
      customMasters: customDocs.map((m) => defined({ code: m.code, name: m.name, description: m.description, titleField: m.titleField, fields: ((m.fields ?? []) as Plain[]).map(spec) })),
    } as CompanyFileInput['masters'],
    maintenance: c.maintenance as CompanyFileInput['maintenance'],
    workspace: defined({ vocabulary: c.vocabulary, stages: c.stages, desks: c.desks }) as CompanyFileInput['workspace'],
  };
  return { file, attachments };
}

/** What the screen needs besides the file: the targets, the masters a data file can fill, the last start. */
export async function kitOptions() {
  return {
    targets: TARGETS.map((key) => ({ key, label: TARGET_LABEL[key], tested: TESTED_TARGETS.includes(key), state: TARGET_STATE[key], needs: TARGET_NEEDS[key], fields: TARGET_FIELDS[key] })),
    capture: await snapshotSummary(),
    masters: listMasters().filter((d) => !d.managed?.create).map((d) => ({
      key: d.key, label: d.label, group: d.group,
      // What must already be there, so spreadsheets can be put in the right order for the person.
      needs: [...new Set(refsOf(d).filter((r) => r.path !== 'branchIds').map((r) => r.target))].filter((t) => t !== d.key),
    })),
    lastApplied: await lastApplied(),
    packages: env.SETUP_PACKAGES,
    /** Whether this copy may be cleared from the screen: never a real company's, once it is live. */
    canClear: await mayClear(),
  };
}

/** A file the kit carries, base64. */
export interface Attachment { path: string; data: string }
export interface KitRequest { file: unknown; attachments?: Attachment[] }

/** Checks a company file and its files: the problems, each with where it is, or the file as it will be written. */
export function check(input: KitRequest & { finish?: Finish }): { ok: boolean; problems: { path: string; message: string }[]; file?: CompanyFile } {
  const parsed = companyFileSchema.safeParse(input.file);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
  // The guided set-up asks for what the money screens can't work without; a file for a deployment may bring them as data.
  const guided = input.finish ? [
    ...(parsed.data.regional.country ? [] : [{ path: 'regional.country', message: 'Choose the country the company works in.' }]),
    ...(parsed.data.regional.baseCurrency ? [] : [{ path: 'regional.baseCurrency', message: 'Choose the currency its books are kept in.' }]),
  ] : [];
  const problems = checkKit(parsed.data, attachmentsOf(input))
    .map((p) => {
      const at = p.indexOf(': ');
      return { path: p.slice(0, at), message: p.slice(at + 2) };
    })
    // Set up here, nothing is deployed, so nothing about deploying can be wrong.
    .filter((p) => input.finish !== 'here' || !p.path.startsWith('deploy'))
    .concat(guided);
  return { ok: problems.length === 0, problems, file: parsed.data };
}

const attachmentsOf = (input: KitRequest) => new Map((input.attachments ?? []).map((a) => [a.path, Buffer.from(a.data, 'base64')]));

/** The zip, when the file is good; otherwise the same answer as check(). */
export async function kitFromDraft(input: KitRequest) {
  if (!env.SETUP_PACKAGES) throw new ForbiddenError("This copy doesn't make packages for other companies.");
  // The guided set-up keeps its files with the draft and doesn't send them again.
  return kit(input.attachments?.length ? input : { ...input, attachments: await draftFiles() });
}

export function kit(input: KitRequest) {
  const result = check(input);
  if (!result.ok || !result.file) return { ...result, zip: undefined, name: undefined };
  // Only the files the company file names go in the kit.
  const named = new Set([...Object.values(result.file.brand.files), ...result.file.data.files.map((f) => f.file)].filter(Boolean));
  const attachments = new Map([...attachmentsOf(input)].filter(([path]) => named.has(path)));
  return { ...result, zip: buildKit(result.file, attachments), name: kitName(result.file) };
}

/* The guided set-up: its draft, saved as the person goes, and setting up this copy. */

export type Finish = 'here' | 'package';
const DRAFT = 'setup-draft';
const DRAFT_FILE = 'setup-draft-file:';

export interface Draft { file: unknown; step?: string; visited?: string[]; finish?: Finish; finishedAt?: string; updatedAt?: string }

/** The draft and its files. Each file has its own record: logos and spreadsheets together could outgrow one. */
export async function readDraft(): Promise<{ draft: Draft | null; attachments: Attachment[] }> {
  const state = await SystemState.findOne({ key: DRAFT }).lean<{ value?: Draft; updatedAt?: Date }>();
  if (!state?.value) return { draft: null, attachments: [] };
  return { draft: { ...state.value, updatedAt: state.updatedAt?.toISOString() }, attachments: await draftFiles() };
}
export async function draftFiles(): Promise<Attachment[]> {
  const docs = await SystemState.find({ key: { $regex: `^${DRAFT_FILE}` } }).lean<{ key: string; value: string }[]>();
  return docs.map((d) => ({ path: d.key.slice(DRAFT_FILE.length), data: d.value }));
}
export async function saveDraft(draft: Draft) {
  const state = await SystemState.findOneAndUpdate({ key: DRAFT }, { $set: { value: draft } }, { upsert: true, new: true }).lean<{ updatedAt?: Date }>();
  return { updatedAt: state?.updatedAt?.toISOString() };
}
export const saveDraftFile = async ({ path, data }: Attachment) => { await SystemState.updateOne({ key: DRAFT_FILE + path }, { $set: { value: data } }, { upsert: true }); };
export const removeDraftFile = async (path: string) => { await SystemState.deleteOne({ key: DRAFT_FILE + path }); };
/** Throws the draft away. What was already set up on this copy stays. */
export const discardDraft = async () => { await SystemState.deleteMany({ key: { $in: [DRAFT] } }); await SystemState.deleteMany({ key: { $regex: `^${DRAFT_FILE}` } }); };

/** What the desks need to offer the set-up: whether this copy has been set up yet, or one is under way. */
export async function setupStatus() {
  const [company, state, last] = await Promise.all([
    Company.exists({}), SystemState.findOne({ key: DRAFT }).select('value.finishedAt value.step').lean<{ value?: Draft }>(), lastApplied(),
  ]);
  return { hasCompany: Boolean(company), applied: Boolean(last), started: Boolean(state?.value), finished: Boolean(state?.value?.finishedAt || last) };
}

/** Clearing is for development and demonstration copies. A real company's data can't be cleared from a screen. */
async function mayClear() {
  if (env.NODE_ENV !== 'production') return true;
  return (await lastApplied())?.purpose === 'demo';
}
const companyName = async () => {
  const c = await Company.findOne().select('tradingName legalName').lean<{ tradingName?: string; legalName?: string }>();
  return c?.tradingName || c?.legalName || '';
};

/**
 * Empties this copy for a new start: every record, except the person doing it and the built-in roles. Files
 * already in storage stay there, unreferenced. Allowed only by mayClear, confirmed by typing the company's name.
 */
export async function clearCopy(confirm: string | undefined, keepUserId: string) {
  if (!(await mayClear())) throw new ForbiddenError("A real company's copy can't be cleared from here.");
  const name = await companyName();
  if (name && (confirm ?? '').trim().toLowerCase() !== name.toLowerCase()) throw new ValidationError(`Type the company's name, ${name}, to clear this copy`, { confirm: ['Does not match'] });
  const models = mongoose.models as Record<string, mongoose.Model<unknown>>;
  for (const [modelName, model] of Object.entries(models)) {
    if (modelName === 'User') await model.deleteMany({ _id: { $ne: keepUserId } });
    else if (modelName === 'Role') await model.deleteMany({ isSystem: { $ne: true } });
    else if (modelName === 'Session') await model.deleteMany({ userId: { $ne: keepUserId } });
    else if (modelName === 'SystemState') await model.deleteMany({ key: { $nin: ['owner-claimed', DRAFT] }, $nor: [{ key: { $regex: `^${DRAFT_FILE}` } }] });
    else await model.deleteMany({});
  }
}

/** Sets up this copy from the draft's company file, telling `onResult` of each step as it finishes. */
export async function applyHere(input: { file: unknown; clear?: { confirm?: string } }, actor: { userId: string }, onResult: (r: Result) => void) {
  const parsed = companyFileSchema.safeParse(input.file);
  if (!parsed.success) throw new ValidationError('The company file has problems', { problems: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  // Once real, always real: re-labelling a real company's copy as a demonstration must not open the way to clearing it.
  const before = await lastApplied();
  if (before?.purpose === 'real' && parsed.data.purpose === 'demo' && env.NODE_ENV === 'production') throw new ForbiddenError("A real company's copy can't become a demonstration.");
  if (input.clear) {
    await clearCopy(input.clear.confirm, actor.userId);
    onResult({ step: 'clear', outcome: 'updated', detail: 'Everything on this copy was removed, except your account.' });
  }
  const files = new Map((await draftFiles()).map((a) => [a.path, Buffer.from(a.data, 'base64')]));
  const named = [...Object.values(parsed.data.brand.files), ...parsed.data.data.files.map((f) => f.file)].filter((n): n is string => Boolean(n));
  const missing = named.filter((n) => !files.has(n));
  if (missing.length) throw new ValidationError(`Add these files again: ${missing.join(', ')}`);
  const read = async (name: string) => files.get(name)!;
  const result = await applyFile(parsed.data, JSON.stringify(parsed.data), read, { onResult, inviteOwner: true });
  const state = await SystemState.findOne({ key: DRAFT }).lean<{ value?: Draft }>();
  if (state?.value) await saveDraft({ ...state.value, finishedAt: new Date().toISOString() });
  const logins = parsed.data.purpose === 'demo' ? await demoLogins(parsed.data, actor.userId, onResult) : [];
  return { ...result, logins };
}

export interface DemoLogin { role: string; login: string; password: string }

/** Letters and digits that can't be mistaken for each other when read aloud in a demonstration. */
const demoPassword = () => {
  const letters = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const pick = (from: string, n: number) => Array.from({ length: n }, () => from[randomInt(from.length)]).join('');
  return `${pick(letters, 5)}-${pick(digits, 4)}-${pick(letters, 5)}`;
};

/**
 * One sign-in per built-in role and one for a driver, so a demonstration can be shown from every side. Made
 * once, with one new password that's shown on the finishing screen and kept nowhere in readable form. Real
 * companies never get these: their people are invited by e-mail.
 */
async function demoLogins(file: CompanyFile, actorId: string, onResult: (r: Result) => void): Promise<DemoLogin[]> {
  const password = demoPassword();
  const system = { actorId, canSeeSensitive: true };
  const out: DemoLogin[] = [];
  for (const key of ['operations', 'finance', 'viewer']) {
    const email = `${key}@${file.company.key}.test`;
    if (await User.exists({ email })) continue;
    const role = await Role.findOne({ key }).select('_id name').lean<{ _id: unknown; name: string }>();
    if (!role) continue;
    try {
      await createUser({ name: `${role.name} (demo)`, email, roleIds: [String(role._id)], password }, system);
      out.push({ role: role.name, login: email, password });
    } catch (err) { onResult({ step: `demo sign-in ${email}`, outcome: 'failed', detail: (err as Error).message }); }
  }
  const driver = await Driver.findOne({ status: 'active', phone: { $exists: true } }).select('_id phone name').lean<{ _id: unknown; phone: string; name?: string }>();
  if (driver && !(await User.exists({ driverId: driver._id } as Plain))) {
    try {
      await DriverAccess.setAccess(String(driver._id), { phone: driver.phone, password }, actorId);
      out.push({ role: `Driver${driver.name ? `: ${driver.name}` : ''}`, login: driver.phone, password });
    } catch (err) { onResult({ step: `demo sign-in ${driver.phone}`, outcome: 'failed', detail: (err as Error).message }); }
  }
  return out;
}

/* Packaging this company as it stands, and what to do with the package. */

/** The guide for a company file: its environment variables and each step, or the problems that come first. */
export function guideFor(input: { file: unknown }) {
  const parsed = companyFileSchema.safeParse(input.file);
  if (!parsed.success) return { problems: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
  return { problems: [], ...deployGuide(parsed.data) };
}

/**
 * The whole company as a package, in one go: the file as given (the screen starts it from this copy), this copy's
 * logos, and, if asked, its records and uploaded files exactly as they stand. Built here, since records and files
 * can be far larger than a request could carry.
 */
export async function packageCurrent(input: { file: unknown; include?: { records?: RecordsLevel; files?: boolean } }) {
  if (!env.SETUP_PACKAGES) throw new ForbiddenError("This copy doesn't make packages for other companies.");
  const level = input.include?.records ?? 'none';
  const attachments = new Map<string, Buffer>((await draftFiles()).map((a) => [a.path, Buffer.from(a.data, 'base64')]));
  for (const a of (await fromInstallation()).attachments) if (!attachments.has(a.path)) attachments.set(a.path, Buffer.from(a.data, 'base64'));
  const file = structuredClone(input.file) as Plain & { data?: Plain };
  if (level !== 'none') {
    const snap = await buildSnapshot(level, Boolean(input.include?.files));
    attachments.set('data/snapshot.json', snap.body);
    for (const [path, body] of snap.uploads) attachments.set(path, body);
    file.data = { ...(file.data ?? {}), sample: 'none', snapshot: 'data/snapshot.json' };
  }
  const parsed = companyFileSchema.safeParse(file);
  if (!parsed.success) return { problems: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  const problems = checkKit(parsed.data, attachments);
  if (problems.length) return { problems };
  const named = new Set([...Object.values(parsed.data.brand.files), ...parsed.data.data.files.map((f) => f.file), parsed.data.data.snapshot].filter(Boolean));
  const carried = new Map([...attachments].filter(([path]) => named.has(path) || path.startsWith('data/upload-')));
  return { problems: [], zip: buildKit(parsed.data, carried), name: kitName(parsed.data) };
}

/** Today's rates from a service that needs no key, so the set-up can show them working before anything is saved. */
export async function ratesPreview(input: { provider: string; base: string; codes: string[] }) {
  const provider = providerFor('rates', input.provider);
  if (!provider) throw new ValidationError('No such rate service');
  if (provider.secrets?.some((s) => s.required)) return { needsKey: true, rates: {} };
  const source = provider.open(contextFor(provider as unknown as Provider)) as { fetch(i: { base: string; codes: string[] }): Promise<{ perBase: Record<string, number>; asOf: Date }> };
  const { perBase, asOf } = await source.fetch({ base: input.base, codes: input.codes });
  return { needsKey: false, rates: perBase, asOf: asOf.toISOString(), missing: input.codes.filter((c) => !perBase[c]) };
}

/**
 * A spreadsheet checked against what the company will have, before anything is saved: each row that would be refused
 * and why. A link to a record in another of its spreadsheets can't be checked yet, so it isn't counted against the row.
 */
export async function checkSheet(input: { master: string; path: string; others?: string[] }) {
  const def = importableMaster(input.master);
  const stored = (await draftFiles()).find((a) => a.path === input.path);
  if (!stored) return { rows: 0, ready: 0, exists: 0, problems: [] };
  const rows = readCsv(Buffer.from(stored.data, 'base64').toString('utf8'));
  const columns = await companyColumns(def);
  const others = new Set(input.others ?? []);
  const waits = new Set(columns.filter((c) => c.target && others.has(c.target)).map((c) => c.label));
  const company = await Company.findOne().select('baseCurrencyId').lean<{ baseCurrencyId?: unknown }>();
  const problems: { row: number; column: string; message: string }[] = [];
  let ready = 0;
  let exists = 0;
  for (let start = 0; start < rows.length; start += MAX_ROWS) {
    const results = await importRows(def, rows.slice(start, start + MAX_ROWS), { dryRun: true, firstRow: start + 2, baseCurrencyId: company?.baseCurrencyId ? String(company.baseCurrencyId) : undefined }, { canSeeSensitive: true });
    for (const r of results) {
      const real = r.problems.filter((p) => !waits.has(p.column));
      if (r.status === 'exists') exists += 1;
      else if (!real.length) ready += 1;
      else for (const p of real) problems.push({ row: r.row, column: p.column, message: p.message });
    }
  }
  return { rows: rows.length, ready, exists, problems: problems.slice(0, 200), problemCount: problems.length };
}
