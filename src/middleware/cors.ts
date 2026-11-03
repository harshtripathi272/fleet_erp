import type { RequestHandler } from 'express';
import { env } from '../config/env.js';

/** Allows only the configured origins (CORS_ORIGINS); everything else gets no CORS headers. */
export const cors: RequestHandler = (req, res, next) => {
  const origin = req.headers.origin;
  // The answer differs by origin once any are allowed, so caches must keep them apart.
  if (env.CORS_ORIGINS.length) res.append('Vary', 'Origin');
  if (origin && env.CORS_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After');
    res.setHeader('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  }
  next();
};
