import { z } from 'zod';
import { email } from '../core/masters/zod.js';

/**
 * Where one copy of a company runs (platform design §5.3): `environments/<name>.json` beside the company's
 * `profile.json`. The same profile runs as a demonstration on a laptop, a trial in the cloud and the company's
 * production copy: three environments, one company. An environment never holds a secret value either.
 *
 * In a format-1 company file the same settings are its `deploy` section, and its `purpose` (demo or real).
 */
export const ENVIRONMENT_FORMAT = 2;

/** Each target's own settings. Secrets are never asked for here. */
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

/** The targets' own settings, shared by a format-1 file's `deploy` and an environment file. */
const GCP = {
  target: z.literal('gcp'), ...common,
  projectId: z.string().trim().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, 'A Google Cloud project id'),
  region: z.string().trim().regex(/^[a-z]+-[a-z]+\d$/).default('africa-south1'),
  domainMode: z.enum(['lb', 'mapping', 'none']).default('lb'),
  egress: z.enum(['static', 'open']).default('static'),
  minInstances: z.number().int().min(0).max(10).default(0),
  maxInstances: z.number().int().min(1).max(10).default(1),
  cpu: z.enum(['1', '2', '4']).default('1'),
  memory: z.enum(['512Mi', '1Gi', '2Gi', '4Gi', '8Gi']).default('512Mi'),
  schedulerRegion: z.string().trim().regex(/^[a-z]+-[a-z]+\d$/).optional(),
  /** Who gets the alerts (#104): when it's down, failing, or near its budget. The owner unless set. */
  alertEmail: email.optional(),
  /** The monthly budget alerted on, in the billing account's own currency. */
  monthlyBudget: z.number().int().min(1).max(1_000_000).default(50),
};
const COMPOSE = {
  target: z.literal('compose'), ...common,
  /** Let's Encrypt's contact for the certificate. */
  certificateEmail: email.optional(),
  backupDays: z.number().int().min(1).max(365).default(14),
};
const AWS = { target: z.literal('aws'), ...common, region: z.string().trim().regex(/^[a-z]{2}-[a-z]+-\d$/).default('af-south-1') };
const AZURE = { target: z.literal('azure'), ...common, location: z.string().trim().regex(/^[a-z0-9]{3,30}$/).default('southafricanorth'), resourceGroup: z.string().trim().regex(/^[A-Za-z0-9._()-]{1,90}$/).optional() };
const RENDER = { target: z.literal('render'), ...common, region: z.enum(['frankfurt', 'oregon', 'ohio', 'virginia', 'singapore']).default('frankfurt') };
const FLY = { target: z.literal('fly'), ...common, region: z.string().trim().regex(/^[a-z]{3}$/).default('jnb') };
const RAILWAY = { target: z.literal('railway'), ...common };
// A separate copy on this computer (#103): its own database and files, at http://localhost:<port>.
const LOCAL = { target: z.literal('local'), ...common, port: z.number().int().min(1024).max(65535).default(8080) };

const variants = <E extends z.ZodRawShape>(extra: E) => z.discriminatedUnion('target', [
  z.strictObject({ ...GCP, ...extra }), z.strictObject({ ...COMPOSE, ...extra }), z.strictObject({ ...AWS, ...extra }), z.strictObject({ ...AZURE, ...extra }),
  z.strictObject({ ...RENDER, ...extra }), z.strictObject({ ...FLY, ...extra }), z.strictObject({ ...RAILWAY, ...extra }), z.strictObject({ ...LOCAL, ...extra }),
]);

/** A format-1 company file's `deploy`: the target and its settings. */
export const deploySchema = variants({});
export type Deploy = z.infer<typeof deploySchema>;

/** Checks Cloud Run would refuse, so they're caught here rather than halfway through a deploy. */
export function refineDeploy(d: { target: string; memory?: string; cpu?: string }, ctx: z.RefinementCtx, at: (string | number)[]) {
  if (d.target !== 'gcp') return;
  if (d.memory === '8Gi' && d.cpu === '1') ctx.addIssue({ code: 'custom', path: [...at, 'memory'], message: '8 GB of memory needs at least 2 CPUs' });
  if (d.cpu === '4' && ['512Mi', '1Gi'].includes(d.memory ?? '')) ctx.addIssue({ code: 'custom', path: [...at, 'memory'], message: '4 CPUs need at least 2 GB of memory' });
}

/** What kind of copy runs there: it becomes the copy's COPY_PURPOSE (src/config/env.ts). */
export const PURPOSES = ['demo', 'trial', 'production'] as const;
export type Purpose = (typeof PURPOSES)[number];
export const PURPOSE_LABEL: Record<Purpose, string> = { demo: 'Demonstration', trial: 'Trial', production: 'Production' };
/** A name for files and resources: demo-local, trial, production, or one of the vendor's own. */
export const environmentName = z.string().trim().regex(/^[a-z][a-z0-9-]{1,30}$/, '2–31 lowercase letters, digits or hyphens, starting with a letter');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const environmentSchema = variants({
  format: z.literal(ENVIRONMENT_FORMAT),
  name: environmentName,
  purpose: z.enum(PURPOSES),
  /** A trial's last day. The copy shows a notice from three days before; nothing is enforced. */
  trialEnds: isoDate.optional(),
  /** Notes on the database, for whoever runs it: where it is and its size. Never its address or password. */
  database: z.strictObject({ kind: z.enum(['atlas', 'bundled', 'other']).optional(), tier: z.string().trim().max(40).optional(), note: z.string().trim().max(500).optional() }).optional(),
  /** What runs there now, written by whoever deploys it (fleet deploy, later). */
  deployed: z.strictObject({ version: z.string().max(40), at: z.string().max(40), revision: z.number().int().min(1).optional(), url: z.string().max(300).optional() }).optional(),
}).superRefine((e, ctx) => {
  refineDeploy(e, ctx, []);
  if (e.trialEnds && e.purpose !== 'trial') ctx.addIssue({ code: 'custom', path: ['trialEnds'], message: 'Only a trial has an end date' });
});
export type Environment = z.infer<typeof environmentSchema>;
export type EnvironmentInput = z.input<typeof environmentSchema>;

/** The keys an environment adds to a target's settings: what a format-1 `deploy` doesn't have. */
const ENVIRONMENT_ONLY = ['format', 'name', 'purpose', 'trialEnds', 'database', 'deployed'] as const;

/** The target's settings alone, as a format-1 file's `deploy`. */
export function deployOf(environment: Environment | EnvironmentInput): Deploy {
  const rest = Object.fromEntries(Object.entries(environment).filter(([k]) => !(ENVIRONMENT_ONLY as readonly string[]).includes(k)));
  return deploySchema.parse(rest);
}

/** A new demonstration on this computer, at the port given (each running copy needs its own). */
export const demoLocal = (port = 8080): Environment => environmentSchema.parse({ format: ENVIRONMENT_FORMAT, name: 'demo-local', purpose: 'demo', target: 'local', port });
