import 'dotenv/config';
import { z } from 'zod';

const flag = (fallback: 'true' | 'false') => z.enum(['true', 'false']).default(fallback).transform((value) => value === 'true');
const optionalText = z.string().trim().min(1).optional();

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
  CONSOLE_ENABLED: flag('true'),
  /** Comma-separated browser origins allowed to call the API, e.g. the React app. */
  CORS_ORIGINS: z.string().default('').transform((v) => v.split(',').map((o) => o.trim()).filter(Boolean)),
  /** Express "trust proxy" setting when running behind a reverse proxy (e.g. 1 for one hop). */
  TRUST_PROXY: z.string().regex(/^(true|false|\d{1,2})$/).default('false').transform((v) => (v === 'true' ? true : v === 'false' ? false : Number(v))),

  SMTP_HOST: optionalText,
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: flag('false'),
  SMTP_USER: optionalText,
  SMTP_PASS: optionalText,
  SMTP_FROM: z.string().trim().min(3).default('Marichi Fleet <no-reply@marichi.local>'),

  /** Shared secret Marichi Talks sends in `X-Webhook-Secret`; the inbound WhatsApp webhook is off without it. */
  MARICHI_TALKS_WEBHOOK_SECRET: z.string().trim().min(16, 'Use at least 16 characters').optional(),
  /** Lets signed-in staff act as a driver's WhatsApp from the app (the simulated phone). */
  DRIVER_PHONE_SIMULATOR: flag('true'),
}).superRefine((value, ctx) => {
  if (value.NODE_ENV !== 'production') return;
  if (value.JWT_SECRET.startsWith('development-only')) {
    ctx.addIssue({ code: 'custom', path: ['JWT_SECRET'], message: 'Set a unique JWT_SECRET in production' });
  }
  if (value.EXPOSE_RESET_TOKEN) {
    ctx.addIssue({ code: 'custom', path: ['EXPOSE_RESET_TOKEN'], message: 'Reset tokens can never be exposed in production' });
  }
  if (!value.SMTP_HOST) {
    ctx.addIssue({ code: 'custom', path: ['SMTP_HOST'], message: 'SMTP is required in production for password resets' });
  }
});

export const env = envSchema.parse(process.env);
export type Env = typeof env;
