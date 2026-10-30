import { Types } from 'mongoose';
type Id = Types.ObjectId | string;
import { logger } from '../logger/index.js';
import { AuditLog } from './audit.model.js';
import type { Plain } from './types.js';

const SECRET_PATHS = /password|token|secret|hash/i;

/** JSON-comparable form: ObjectIds and dates become strings. */
export function comparable(value: unknown): unknown {
  if (value instanceof Types.ObjectId) return value.toHexString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(comparable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Plain).filter(([, v]) => v !== undefined).map(([k, v]) => [k, comparable(v)]));
  }
  return value;
}

export function diff(before: Plain, after: Plain, masked: string[] = []): Array<{ path: string; from: unknown; to: unknown }> {
  const skip = new Set(['_id', 'version', 'updatedAt', 'createdAt', 'updatedBy']);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: Array<{ path: string; from: unknown; to: unknown }> = [];
  for (const key of keys) {
    if (skip.has(key)) continue;
    const from = comparable(before[key]);
    const to = comparable(after[key]);
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    const hide = SECRET_PATHS.test(key) || masked.some((m) => m === key || m.startsWith(`${key}.`));
    out.push({ path: key, from: hide ? '[hidden]' : from, to: hide ? '[hidden]' : to });
  }
  return out;
}

interface AuditInput {
  entity: string; entityId: unknown; action: 'create' | 'update' | 'archive' | 'restore' | 'delete' | 'custom';
  summary?: string; actorId?: string; requestId?: string; changes?: Array<{ path: string; from: unknown; to: unknown }>;
}

/** Writes an audit entry. A failed audit write is logged but never undoes the change. */
export async function audit(input: AuditInput): Promise<void> {
  try {
    await AuditLog.create({ ...input, entityId: input.entityId as Id, changes: input.changes ?? [] });
  } catch (err) {
    logger.error({ err, entity: input.entity, action: input.action }, 'Audit write failed');
  }
}
