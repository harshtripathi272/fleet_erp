import type { RequestHandler } from 'express';
import { BadRequestError } from '../core/errors/index.js';

/** Rejects JSON keys that MongoDB would treat as operators ($...) or paths (a.b). */
function findBadKey(value: unknown, depth = 0): string | null {
  if (depth > 20) return '(nesting deeper than 20 levels)';
  if (Array.isArray(value)) {
    for (const item of value) { const bad = findBadKey(item, depth + 1); if (bad) return bad; }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith('$') || key.includes('.') || key === '__proto__' || key === 'constructor' || key === 'prototype') return key;
      const bad = findBadKey(child, depth + 1);
      if (bad) return bad;
    }
  }
  return null;
}

export const rejectOperators: RequestHandler = (req, _res, next) => {
  const bad = findBadKey(req.body) ?? findBadKey(req.query);
  if (bad) throw new BadRequestError(`Field name "${bad}" is not allowed`);
  next();
};
