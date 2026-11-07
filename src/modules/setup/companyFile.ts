import { z } from 'zod';
import { KINDS, SECRET_ENV, SECRET_ENV_HINT, providerFor } from '../../core/connections/index.js';
import { email, name, phone, text } from '../../core/masters/zod.js';
import { AREA_KEYS } from '../company/areaList.js';
import { saveCompanySchema } from '../company/company.schema.js';
import { workspaceInput } from '../company/workspace.js';
import { customMasterShape, fieldDefinitionShape, listShape } from '../configuration/configuration.schema.js';
import { layoutInputSchema } from '../../core/masters/layout.js';
import { PERMISSION_ACTIONS } from '../roles/roles.schema.js';

/**
 * The company file (#76): everything that makes one installation this company, in one versioned file a
 * developer writes on the Company kit screen or by hand. It never holds a secret: passwords and keys are
 * named by the server setting that holds them, and their values live only in that installation's settings.
 */
export const COMPANY_FILE_FORMAT = 1;

/** Short name used in resource names and the kit's file name, as deploy/new-company.sh expects. */
export const companyKey = z.string().trim().regex(/^[a-z][a-z0-9-]{2,29}$/, '3–30 lowercase letters, digits or hyphens, starting with a letter');
/** A file inside the kit, next to the company file: `files/logo.png`, `data/vehicles.csv`. */
const kitPath = (folder: string) => z.string().trim().regex(new RegExp(`^${folder}/[A-Za-z0-9._-]{1,80}$`), `A file in the kit's ${folder}/ folder, e.g. ${folder}/example`);
const secretName = z.string().trim().regex(SECRET_ENV, SECRET_ENV_HINT);
const unique = <T>(of: (item: T) => string, what: string) => (list: T[], ctx: z.RefinementCtx) => {
  const seen = new Set<string>();
  list.forEach((item, i) => {
    const key = of(item).toLowerCase();
    if (seen.has(key)) ctx.addIssue({ code: 'custom', path: [i], message: `${what} "${of(item)}" appears twice` });
    seen.add(key);
  });
};

const company = saveCompanySchema.shape;
const brandText = company.brand.unwrap().omit({ logoFileId: true, logoDarkFileId: true, iconFileId: true, logoPdfFileId: true });

/** The company's own files; the kit carries them under files/. */
export const BRAND_FILES = { logo: 'logoFileId', logoDark: 'logoDarkFileId', icon: 'iconFileId', logoPdf: 'logoPdfFileId' } as const;
export type BrandFile = keyof typeof BRAND_FILES;

const connection = z.strictObject({
  code: z.string().trim().min(1).max(32),
  name,
  description: text(500).optional(),
  kind: z.enum(KINDS),
  provider: z.string().trim().regex(/^[a-z][a-z0-9-]{1,39}$/),
  enabled: z.boolean().default(false),
  settings: z.record(z.string().max(60), z.unknown()).default({}),
  secrets: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,39}$/), secretName).default({}),
  webhookSecretEnv: secretName.optional(),
}).superRefine((c, ctx) => {
  // Checked against the provider's own form, so a file written by hand fails here and not on the server.
  const provider = providerFor(c.kind, c.provider);
  if (!provider) { ctx.addIssue({ code: 'custom', path: ['provider'], message: `No ${c.kind} provider "${c.provider}"` }); return; }
  if (provider.comingSoon) { ctx.addIssue({ code: 'custom', path: ['provider'], message: provider.comingSoon }); return; }
  const settings = provider.fields.safeParse(c.settings);
  if (!settings.success) for (const issue of settings.error.issues) ctx.addIssue({ code: 'custom', path: ['settings', ...issue.path.map(String)], message: issue.message });
  const known = new Set((provider.secrets ?? []).map((s) => s.key));
  for (const key of Object.keys(c.secrets)) if (!known.has(key)) ctx.addIssue({ code: 'custom', path: ['secrets', key], message: `${provider.label} has no secret "${key}"` });
  for (const s of provider.secrets ?? []) if (s.required && !c.secrets[s.key]) ctx.addIssue({ code: 'custom', path: ['secrets', s.key], message: `Name the server setting that holds the ${s.label.toLowerCase()}` });
  // Meta and Twilio sign their calls themselves, so only our own webhooks need a signing secret named.
  if (provider.inbound && !provider.verifyInbound && c.enabled && !c.webhookSecretEnv) ctx.addIssue({ code: 'custom', path: ['webhookSecretEnv'], message: 'Name the server setting that holds the signing secret for calls from this service' });
});

const role = z.strictObject({
  key: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_-]{1,39}$/),
  name: text(80),
  description: text(500).optional(),
  permissions: z.array(z.strictObject({ resource: z.string().trim().min(1).max(60), actions: z.array(z.enum(PERMISSION_ACTIONS)).min(1).max(7) })).max(200),
});

/* The masters, as this company shapes them: nothing here is code, so a company's system travels in its file. */
const { listId: _fieldList, ...fieldSpecShape } = {
  key: fieldDefinitionShape.key, label: fieldDefinitionShape.label, type: fieldDefinitionShape.type, required: fieldDefinitionShape.required,
  options: fieldDefinitionShape.options, listId: fieldDefinitionShape.listId, referenceMaster: fieldDefinitionShape.referenceMaster,
  min: fieldDefinitionShape.min, max: fieldDefinitionShape.max, maxLength: fieldDefinitionShape.maxLength, pattern: fieldDefinitionShape.pattern,
  helpText: fieldDefinitionShape.helpText, order: fieldDefinitionShape.order,
  maxSizeMb: fieldDefinitionShape.maxSizeMb, maxFiles: fieldDefinitionShape.maxFiles, accept: fieldDefinitionShape.accept, withExpiry: fieldDefinitionShape.withExpiry,
};
/** A field's list is named by its code: ids mean nothing on another copy. */
const fieldSpec = { ...fieldSpecShape, listCode: z.string().trim().min(1).max(32).optional() };
const mastersPart = z.strictObject({
  /** Names, order, sections, required and hidden fields, list columns and choices, per master. */
  layouts: z.array(layoutInputSchema.extend({ entity: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/) })).max(200).default([]).superRefine(unique((l) => l.entity, 'Master')),
  lists: z.array(z.strictObject({ code: listShape.code, name: listShape.name, description: listShape.description, values: listShape.values })).max(200).default([]).superRefine(unique((l) => l.code, 'List')),
  /** The company's own fields on built-in masters and trip records. */
  fields: z.array(z.strictObject({ entity: fieldDefinitionShape.entity, ...fieldSpec, placement: fieldDefinitionShape.placement, askedOf: fieldDefinitionShape.askedOf, printOn: fieldDefinitionShape.printOn })).max(1000).default([]).superRefine(unique((f) => `${f.entity}.${f.key}`, 'Field')),
  /** Masters defined entirely by the company. */
  customMasters: z.array(z.strictObject({ code: customMasterShape.code, name: customMasterShape.name, description: customMasterShape.description, titleField: customMasterShape.titleField, fields: z.array(z.strictObject(fieldSpec)).min(1).max(60) })).max(100).default([]).superRefine(unique((m) => m.code, 'Master')),
});

const person = z.strictObject({ name: name.optional(), email, phone: phone.optional(), roles: z.array(z.string().trim().min(1).max(40)).max(20).default([]) });

/** Where and how the company runs. Each target's own settings; secrets are never asked for here. */
const smtp = z.strictObject({
  host: z.string().trim().min(1).max(200),
  port: z.number().int().min(1).max(65535).default(587),
  secure: z.boolean().default(false),
  user: z.string().trim().min(1).max(200).optional(),
  from: z.string().trim().min(3).max(200),
});
const common = {
  /** The public address, e.g. fleet.acme.example. Empty: the platform's own address. */
  domain: z.string().trim().toLowerCase().regex(/^(?=.{4,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/, 'A host name such as fleet.acme.example').optional(),
  /**
   * The shared image, without its version: the version is chosen when deploying, never kept here. On Google
   * Cloud it defaults to the project's own registry (<region>-docker.pkg.dev/<project>/fleet/fleet-erp).
   */
  image: z.string().trim().regex(/^[a-z0-9.-]+(:\d+)?(\/[a-z0-9._-]+)+$/, 'An image name without a tag, e.g. ghcr.io/acme/fleet-erp').optional(),
  smtp: smtp.optional(),
};
export const TARGETS = ['gcp', 'compose', 'local', 'aws', 'azure', 'render', 'fly', 'railway'] as const;
export type Target = (typeof TARGETS)[number];
const deploy = z.discriminatedUnion('target', [
  z.strictObject({
    target: z.literal('gcp'), ...common,
    projectId: z.string().trim().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, 'A Google Cloud project id'),
    region: z.string().trim().regex(/^[a-z]+-[a-z]+\d$/).default('africa-south1'),
    domainMode: z.enum(['lb', 'mapping', 'none']).default('lb'),
    egress: z.enum(['static', 'open']).default('static'),
    minInstances: z.number().int().min(0).max(10).default(0),
    maxInstances: z.number().int().min(1).max(10).default(1),
    schedulerRegion: z.string().trim().regex(/^[a-z]+-[a-z]+\d$/).optional(),
    /** Who gets the alerts (#104): when it's down, failing, or near its budget. The owner unless set. */
    alertEmail: email.optional(),
    /** The monthly budget alerted on, in the billing account's own currency. */
    monthlyBudget: z.number().int().min(1).max(1_000_000).default(50),
  }),
  z.strictObject({
    target: z.literal('compose'), ...common,
    /** Let's Encrypt's contact for the certificate. */
    certificateEmail: email.optional(),
    backupDays: z.number().int().min(1).max(365).default(14),
  }),
  z.strictObject({ target: z.literal('aws'), ...common, region: z.string().trim().regex(/^[a-z]{2}-[a-z]+-\d$/).default('af-south-1') }),
  z.strictObject({ target: z.literal('azure'), ...common, location: z.string().trim().regex(/^[a-z0-9]{3,30}$/).default('southafricanorth'), resourceGroup: z.string().trim().regex(/^[A-Za-z0-9._()-]{1,90}$/).optional() }),
  z.strictObject({ target: z.literal('render'), ...common, region: z.enum(['frankfurt', 'oregon', 'ohio', 'virginia', 'singapore']).default('frankfurt') }),
  z.strictObject({ target: z.literal('fly'), ...common, region: z.string().trim().regex(/^[a-z]{3}$/).default('jnb') }),
  z.strictObject({ target: z.literal('railway'), ...common }),
  // A separate copy on this computer (#103): its own database and files, at http://localhost:<port>.
  z.strictObject({ target: z.literal('local'), ...common, port: z.number().int().min(1024).max(65535).default(8080) }),
]);

export const companyFileSchema = z.strictObject({
  format: z.literal(COMPANY_FILE_FORMAT),
  /** A demonstration copy may be cleared and started again, and needs no e-mail server. A real company's may not. */
  purpose: z.enum(['demo', 'real']).default('real'),
  company: z.strictObject({
    key: companyKey,
    legalName: text(200),
    tradingName: company.tradingName,
    registrationNumber: company.registrationNumber,
    taxId: company.taxId,
    address: company.address,
    phone: company.phone,
    email: company.email,
    website: company.website,
  }),
  /** Codes, not ids: they are looked up once the data is in. */
  regional: z.strictObject({
    country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'A two-letter country code, e.g. ZM').optional(),
    baseCurrency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'A three-letter currency code, such as USD').optional(),
    timezone: company.timezone,
    dateFormat: company.dateFormat,
    fiscalYearStartMonth: company.fiscalYearStartMonth,
    /** Clock, number style, week, phone code and units. Left out, each follows the country or the default. */
    style: company.regional,
    /** Other currencies it works in, as codes; each is added if missing, and the rate feed follows them. */
    currencies: z.array(z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/)).max(60).optional(),
  }).default({}),
  brand: brandText.extend({ files: z.strictObject({ logo: kitPath('files').optional(), logoDark: kitPath('files').optional(), icon: kitPath('files').optional(), logoPdf: kitPath('files').optional() }).default({}) }).default({ files: {} }),
  watermark: company.watermark,
  areas: z.array(z.enum(AREA_KEYS)).max(AREA_KEYS.length).optional(),
  operations: company.operations,
  maintenance: company.maintenance,
  /** The company's own words, trip stages and desks. Only what differs from the defaults. */
  workspace: z.strictObject(workspaceInput).optional(),
  masters: mastersPart.optional(),
  /** Anyone may make an account, waiting for a role; off unless the company asks for it. */
  selfSignUp: z.boolean().default(false),
  connections: z.array(connection).max(50).default([]).superRefine(unique((c) => c.code, 'Connection')),
  /** The company's own roles; the built-in ones (Owner, Operations…) come with every installation. */
  roles: z.array(role).max(50).default([]).superRefine(unique((r) => r.key, 'Role')),
  owner: z.strictObject({ name: name.optional(), email }),
  staff: z.array(person).max(200).default([]).superRefine(unique((p) => p.email, 'E-mail')),
  data: z.strictObject({
    /** The sample operation, for a demonstration copy; never for a company's real one. */
    sample: z.enum(['none', 'small', 'full']).default('none'),
    /** Imported in this order on first start, like the import screen: a row already there is left alone. */
    files: z.array(z.strictObject({ master: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/), file: kitPath('data') })).max(60).default([]).superRefine(unique((f) => f.file, 'Data file')),
    /** This company's records exactly as they stood on the copy it was packaged from, restored once on first start. */
    snapshot: kitPath('data').optional(),
  }).default({ sample: 'none', files: [] }),
  deploy,
}).superRefine((file, ctx) => {
  if (file.staff.some((p) => p.email === file.owner.email)) ctx.addIssue({ code: 'custom', path: ['staff'], message: 'The owner is set under owner, not again under staff' });
  const enabled = new Map<string, string>();
  file.connections.forEach((c, i) => {
    if (!c.enabled) return;
    if (enabled.has(c.kind)) ctx.addIssue({ code: 'custom', path: ['connections', i, 'enabled'], message: `Only one ${c.kind} connection can be switched on; ${enabled.get(c.kind)} already is` });
    enabled.set(c.kind, c.code);
  });
});

export type CompanyFile = z.infer<typeof companyFileSchema>;
export type CompanyFileInput = z.input<typeof companyFileSchema>;

/** Every server setting a company file names for a secret: what the kit's .env leaves blank for someone to fill. */
export function secretSettings(file: CompanyFile): { name: string; why: string }[] {
  const out = new Map<string, string>();
  for (const c of file.connections) {
    const provider = providerFor(c.kind, c.provider);
    for (const [key, setting] of Object.entries(c.secrets)) out.set(setting, `${c.name}: ${provider?.secrets?.find((s) => s.key === key)?.label ?? key}`);
    if (c.webhookSecretEnv) out.set(c.webhookSecretEnv, `${c.name}: signing secret for calls from the service`);
  }
  return [...out].map(([name, why]) => ({ name, why }));
}
