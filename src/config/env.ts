import 'dotenv/config';
import { z } from 'zod';

const flag = (fallback: 'true' | 'false') => z.enum(['true', 'false']).default(fallback).transform((value) => value === 'true');
const optionalText = z.string().trim().min(1).optional();
/** A browser origin: scheme, host and optional port, nothing after it. */
const ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i;
const isLoopback = (url: string) => /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(url);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1).max(120000).default(10000),

  MONGODB_URI: z.string().trim().regex(/^mongodb(\+srv)?:\/\//, 'Must be a MongoDB connection string').default('mongodb://127.0.0.1:27017/fleet_erp'),
  REDIS_URL: z.string().trim().regex(/^rediss?:\/\//, 'Must be a Redis URL').optional(),

  APP_URL: z.url().default('http://127.0.0.1:3000'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters').default('development-only-secret-change-me-0123456789'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
  LOGIN_MAX_FAILURES: z.coerce.number().int().min(3).max(20).default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  PASSWORD_HASH_COST: z.coerce.number().int().min(10).max(17).default(15),
  EXPOSE_RESET_TOKEN: flag('false'),
  /**
   * The e-mail of the company's first Owner. When set, that account is created at start-up and sent a
   * link to choose a password, and nobody can become the first Owner by signing up. Required in production.
   */
  OWNER_EMAIL: z.string().trim().toLowerCase().pipe(z.email()).optional(),
  /**
   * The first Owner's password, for a copy with no e-mail server. Read only when that first account is made, and
   * never again: it can't change an existing account. Without it, the Owner gets an e-mail to choose one.
   */
  OWNER_PASSWORD: z.string().min(8, 'OWNER_PASSWORD must be at least 8 characters').max(128).regex(/[A-Za-z]/, 'OWNER_PASSWORD needs a letter').regex(/\d/, 'OWNER_PASSWORD needs a digit').optional(),
  /**
   * The way back in when the only Owner has forgotten their password and there's no e-mail to reset it by. Whoever runs
   * this copy sets it and restarts: the OWNER_EMAIL account takes this password once, and must change it at sign-in.
   */
  OWNER_PASSWORD_RESET: z.string().min(8, 'OWNER_PASSWORD_RESET must be at least 8 characters').max(128).regex(/[A-Za-z]/, 'OWNER_PASSWORD_RESET needs a letter').regex(/\d/, 'OWNER_PASSWORD_RESET needs a digit').optional(),
  CONSOLE_ENABLED: flag('true'),
  /** Timers inside the server for what a scheduled job does where one runs. Cloud Run turns this off: it scales to zero. */
  IN_PROCESS_JOBS: flag('true'),
  /** Comma-separated browser origins allowed to call the API, e.g. the React app. */
  CORS_ORIGINS: z.string().default('').transform((v) => v.split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean))
    .refine((list) => list.every((o) => ORIGIN.test(o)), 'Each origin is a scheme and host, e.g. https://app.example.com, with no path and no *'),
  /** Express "trust proxy" setting when running behind a reverse proxy (e.g. 1 for one hop). */
  TRUST_PROXY: z.string().regex(/^(true|false|\d{1,2})$/).default('false').transform((v) => (v === 'true' ? true : v === 'false' ? false : Number(v))),

  SMTP_HOST: optionalText,
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: flag('false'),
  SMTP_USER: optionalText,
  SMTP_PASS: optionalText,
  /** API key of the exchange-rate provider chosen under Exchange rates → Rate feed (a secret; never stored or returned). */
  RATE_FEED_API_KEY: optionalText,
  SMTP_FROM: z.string().trim().min(3).default('no-reply@fleet.local'),

  /** A company kit's company.json (#76), applied on every start: the first time in full, then only what it changed. */
  COMPANY_CONFIG: optionalText,
  /**
   * What kind of copy this is (#95, platform design): a demonstration with made-up data that can be reset, a
   * company's trial, or a company's production copy. Set by whoever deploys it, never from a screen. Defaults:
   * production in production, demo elsewhere.
   */
  COPY_PURPOSE: z.enum(['demo', 'trial', 'production']).optional(),
  /** A trial's last day (YYYY-MM-DD). The app shows a notice from three days before; nothing is enforced. */
  TRIAL_ENDS: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional(),
  /** Allows COPY_PURPOSE=demo in production: a demonstration copy on Cloud Run for sales, made-up data only. */
  DEMO_IN_PRODUCTION: flag('false'),
  /** The version this copy runs, shown under This installation; deploy scripts set it to the image's git commit. */
  APP_VERSION: optionalText,
  /** Whether "Set up a company" may download packages for other companies. Off on a real company's own copy. */
  SETUP_PACKAGES: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),

  /** Folder of the built web app; defaults to web/dist next to the API. The app is served only when it has been built. */
  WEB_DIR: z.string().trim().min(1).optional(),

  /** Where uploaded files (document photos, PDFs) are kept: a folder on the server, or a Google Cloud Storage bucket. */
  FILE_STORAGE: z.enum(['local', 'gcs']).default('local'),
  /** Folder for `FILE_STORAGE=local`, relative to where the API starts. On Cloud Run use `gcs`: its disk is wiped on restart. */
  FILE_STORAGE_DIR: z.string().trim().min(1).default('data/files'),
  /** Bucket for `FILE_STORAGE=gcs`. Credentials come from the environment (the service account on GCP). */
  GCS_BUCKET: optionalText,
  /** Largest file one upload may carry. */
  UPLOAD_MAX_MB: z.coerce.number().min(1).max(100).default(15),

  /** Shared secret Marichi Talks sends in `X-Webhook-Secret`; the inbound WhatsApp webhook is off without it. */
  MARICHI_TALKS_WEBHOOK_SECRET: z.string().trim().min(16, 'Use at least 16 characters').optional(),
  /**
   * The simulators: staff acting as a driver's WhatsApp (the simulated phone) and the drive simulator, labelled
   * "simulated". On by default outside production. In production only on a demonstration or trial copy (#139: the
   * test copy on Render), never on a company's production copy.
   */
  DRIVER_PHONE_SIMULATOR: z.enum(['true', 'false']).optional(),
}).superRefine((value, ctx) => {
  if (value.FILE_STORAGE === 'gcs' && !value.GCS_BUCKET) {
    ctx.addIssue({ code: 'custom', path: ['GCS_BUCKET'], message: 'Set GCS_BUCKET when FILE_STORAGE is gcs' });
  }
  if (value.NODE_ENV !== 'production') return;
  if (value.JWT_SECRET.startsWith('development-only')) {
    ctx.addIssue({ code: 'custom', path: ['JWT_SECRET'], message: 'Set a unique JWT_SECRET in production' });
  }
  if (value.EXPOSE_RESET_TOKEN) {
    ctx.addIssue({ code: 'custom', path: ['EXPOSE_RESET_TOKEN'], message: 'Reset tokens can never be exposed in production' });
  }
  if (value.COPY_PURPOSE === 'demo' && !value.DEMO_IN_PRODUCTION) {
    ctx.addIssue({ code: 'custom', path: ['COPY_PURPOSE'], message: 'A demonstration copy in production needs DEMO_IN_PRODUCTION=true: it can be reset, which removes every record' });
  }
  if (value.DRIVER_PHONE_SIMULATOR === 'true' && (value.COPY_PURPOSE ?? 'production') === 'production') {
    ctx.addIssue({ code: 'custom', path: ['DRIVER_PHONE_SIMULATOR'], message: 'The simulated driver phone cannot run on a production copy: set COPY_PURPOSE=trial or demo for a test copy' });
  }
  if (isLoopback(value.APP_URL) || !value.APP_URL.startsWith('https://')) {
    ctx.addIssue({ code: 'custom', path: ['APP_URL'], message: 'Set APP_URL to the public https:// address in production; it is used in password links' });
  }
  if (value.TRUST_PROXY === true) {
    ctx.addIssue({ code: 'custom', path: ['TRUST_PROXY'], message: 'Set TRUST_PROXY to the number of proxies (e.g. 1), not true: true lets clients choose their own address and slip past rate limits' });
  }
  if (value.CORS_ORIGINS.some((o) => o.startsWith('http://'))) {
    ctx.addIssue({ code: 'custom', path: ['CORS_ORIGINS'], message: 'Browser origins must be https:// in production' });
  }
  if (!value.OWNER_EMAIL) {
    ctx.addIssue({ code: 'custom', path: ['OWNER_EMAIL'], message: 'Set OWNER_EMAIL in production, so a stranger cannot claim the first Owner account' });
  }
  // Someone must be able to get in: by an e-mail to choose a password, or with the one set here.
  if (!value.SMTP_HOST && !(value.OWNER_EMAIL && value.OWNER_PASSWORD)) {
    ctx.addIssue({ code: 'custom', path: ['SMTP_HOST'], message: 'Production needs SMTP_HOST for invitations and password resets, or OWNER_EMAIL and OWNER_PASSWORD for the first Owner' });
  }
}).transform((value) => ({
  ...value,
  DRIVER_PHONE_SIMULATOR: (value.DRIVER_PHONE_SIMULATOR ?? (value.NODE_ENV === 'production' ? 'false' : 'true')) === 'true',
  COPY_PURPOSE: value.COPY_PURPOSE ?? (value.NODE_ENV === 'production' ? 'production' : 'demo'),
}));

/**
 * On Render the public address is known without being typed: RENDER_EXTERNAL_URL (https://<service>.onrender.com).
 * APP_URL, when set, wins (a company's own domain).
 */
export const envSource = (source: NodeJS.ProcessEnv) => ({ ...source, APP_URL: source.APP_URL || source.RENDER_EXTERNAL_URL || undefined });

export const env = envSchema.parse(envSource(process.env));
export type Env = typeof env;
