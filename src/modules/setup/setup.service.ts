import { env } from '../../config/env.js';
import { listMasters } from '../../core/masters/registry.js';
import { storeOf } from '../../core/storage/index.js';
import type { Plain } from '../../core/masters/types.js';
import { getMaster } from '../../core/masters/registry.js';
import { Company } from '../company/company.model.js';
import { Connection } from '../connections/connection.model.js';
import { StoredFile } from '../files/file.model.js';
import { Role } from '../roles/role.model.js';
import { lastApplied } from './apply.js';
import { BRAND_FILES, COMPANY_FILE_FORMAT, type CompanyFile, type CompanyFileInput, TARGETS, companyFileSchema } from './companyFile.js';
import { TARGET_LABEL, TESTED_TARGETS, buildKit, checkKit, kitName } from './kit.js';

/**
 * The Company kit screen (#76). It starts from this installation, where the company was set up on the usual
 * screens, and adds what only a deployment needs: the owner, the staff, the data files and where it runs.
 */

/** A short name for resource names, from the company's name: "Acme Haulage Ltd" → acme-haulage-ltd. */
const keyOf = (name: string) => {
  const key = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '');
  return /^[a-z]/.test(key) && key.length >= 3 ? key : `co-${key}`.slice(0, 30);
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
    owner: { email: env.OWNER_EMAIL ?? '' },
    staff: [],
    data: { sample: 'none', files: [] },
    deploy: { target: 'compose' },
  };
  return { file, attachments };
}

/** What the screen needs besides the file: the targets, the masters a data file can fill, the last start. */
export async function kitOptions() {
  return {
    targets: TARGETS.map((key) => ({ key, label: TARGET_LABEL[key], tested: TESTED_TARGETS.includes(key) })),
    masters: listMasters().filter((d) => !d.managed?.create).map((d) => ({ key: d.key, label: d.label })),
    lastApplied: await lastApplied(),
  };
}

/** A file the kit carries, base64. */
export interface Attachment { path: string; data: string }
export interface KitRequest { file: unknown; attachments?: Attachment[] }

/** Checks a company file and its files: the problems, each with where it is, or the file as it will be written. */
export function check(input: KitRequest): { ok: boolean; problems: { path: string; message: string }[]; file?: CompanyFile } {
  const parsed = companyFileSchema.safeParse(input.file);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
  const problems = checkKit(parsed.data, attachmentsOf(input)).map((p) => {
    const at = p.indexOf(': ');
    return { path: p.slice(0, at), message: p.slice(at + 2) };
  });
  return { ok: problems.length === 0, problems, file: parsed.data };
}

const attachmentsOf = (input: KitRequest) => new Map((input.attachments ?? []).map((a) => [a.path, Buffer.from(a.data, 'base64')]));

/** The zip, when the file is good; otherwise the same answer as check(). */
export function kit(input: KitRequest) {
  const result = check(input);
  if (!result.ok || !result.file) return { ...result, zip: undefined, name: undefined };
  // Only the files the company file names go in the kit.
  const named = new Set([...Object.values(result.file.brand.files), ...result.file.data.files.map((f) => f.file)].filter(Boolean));
  const attachments = new Map([...attachmentsOf(input)].filter(([path]) => named.has(path)));
  return { ...result, zip: buildKit(result.file, attachments), name: kitName(result.file) };
}
