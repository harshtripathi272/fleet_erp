import { createRequire } from 'node:module';
import pino from 'pino';
import { env } from '../../config/env.js';

/** Pretty logs are a developer's tool, left out of the built image: a copy running in development mode there must still start. */
const hasPrettyPrinter = () => {
  try { createRequire(import.meta.url).resolve('pino-pretty'); return true; } catch { return false; }
};

/** Fields that never reach the logs, wherever they sit in a logged object (up to three levels deep). */
export const SECRET_KEYS = [
  'password', 'currentPassword', 'newPassword', 'passwordHash',
  'token', 'accessToken', 'refreshToken', 'resetToken', 'tokenHash', 'tokens', 'hash',
  'secret', 'authorization', 'cookie', 'apiKey',
];
const HEADER_KEYS = ['authorization', 'cookie', 'x-webhook-secret'];

export const REDACT_PATHS = [
  ...SECRET_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
  ...HEADER_KEYS.flatMap((key) => [`headers["${key}"]`, `req.headers["${key}"]`]),
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: REDACT_PATHS,
  ...(env.NODE_ENV === 'development' && hasPrettyPrinter() ? {
    transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } },
  } : {}),
});
