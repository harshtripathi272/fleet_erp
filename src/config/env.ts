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
  CONSOLE_ENABLED: flag('true'),
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
  /** The simulators: staff acting as a driver's WhatsApp (the simulated phone) and the drive simulator. On by default outside production; refused in production. */
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
  if (value.DRIVER_PHONE_SIMULATOR === 'true') {
    ctx.addIssue({ code: 'custom', path: ['DRIVER_PHONE_SIMULATOR'], message: 'The simulated driver phone cannot run in production' });
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
  if (!value.SMTP_HOST) {
    ctx.addIssue({ code: 'custom', path: ['SMTP_HOST'], message: 'SMTP is required in production for password resets' });
  }
}).transform((value) => ({ ...value, DRIVER_PHONE_SIMULATOR: (value.DRIVER_PHONE_SIMULATOR ?? (value.NODE_ENV === 'production' ? 'false' : 'true')) === 'true' }));

export const env = envSchema.parse(process.env);
export type Env = typeof env;
