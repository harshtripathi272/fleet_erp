import pino from 'pino';
import { env } from '../../config/env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: ['password', 'token', 'authorization', 'cookie', 'req.headers.authorization', 'req.headers.cookie'],
  ...(env.NODE_ENV === 'development' ? {
    transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } },
  } : {}),
});
