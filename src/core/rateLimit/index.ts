import type { Request, RequestHandler } from 'express';
import { getRedis } from '../cache/redis.js';
import { TooManyRequestsError } from '../errors/index.js';
import { MemoryRateLimitStore, RedisRateLimitStore, type RateLimitStore } from './limiter.js';

export * from './limiter.js';

const memory = new MemoryRateLimitStore();
let override: RateLimitStore | null = null;

export function setRateLimitStore(store: RateLimitStore | null) { override = store; }
export function rateLimitStore(): RateLimitStore {
  if (override) return override;
  const redis = getRedis();
  return redis ? new RedisRateLimitStore(redis) : memory;
}

export interface RateLimitOptions {
  name: string;
  limit: number;
  windowMs: number;
  key?: (req: Request) => string;
}

export const clientIp = (req: Request) => req.ip ?? req.socket.remoteAddress ?? 'unknown';

/** Express middleware: rejects with 429 once the window's limit is exceeded. */
export const rateLimit = ({ name, limit, windowMs, key = clientIp }: RateLimitOptions): RequestHandler => Object.assign<RequestHandler, { meta: object }>(async (req, res, next) => {
  const result = await rateLimitStore().hit(`${name}:${key(req)}`, limit, windowMs);
  res.setHeader('RateLimit-Limit', String(limit));
  res.setHeader('RateLimit-Remaining', String(result.remaining));
  res.setHeader('RateLimit-Reset', String(Math.ceil(result.resetMs / 1000)));
  if (!result.allowed) {
    res.setHeader('Retry-After', String(Math.ceil(result.resetMs / 1000)));
    throw new TooManyRequestsError('Too many requests, try again later', { retryAfterSeconds: Math.ceil(result.resetMs / 1000) });
  }
  next();
}, { meta: { rateLimit: { name, limit, windowSeconds: windowMs / 1000 } } });
