import { AuditLog } from '../../core/masters/audit.model.js';
import { comparable } from '../../core/masters/audit.js';
import type { Plain } from '../../core/masters/types.js';
import { User } from '../users/user.model.js';
import type { AuditQuery } from './audit.schema.js';

export async function listAuditLogs(query: AuditQuery) {
  const filter: Plain = {};
  if (query.entity) filter.entity = query.entity;
  if (query.entityId) filter.entityId = query.entityId;
  if (query.actorId) filter.actorId = query.actorId;
  if (query.action) filter.action = query.action;
  if (query.from || query.to) filter.at = { ...(query.from ? { $gte: query.from } : {}), ...(query.to ? { $lte: query.to } : {}) };
  const [rows, total] = await Promise.all([
    AuditLog.find(filter).sort({ at: -1, _id: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
    AuditLog.countDocuments(filter),
  ]);
  const actorIds = [...new Set(rows.map((r) => String(r.actorId ?? '')).filter(Boolean))];
  const actors = await User.find({ _id: { $in: actorIds } }).select('name email').lean();
  const names = new Map(actors.map((a) => [String(a._id), a.name]));
  const data = rows.map((r) => {
    const { _id, ...rest } = comparable(r) as Plain;
    return { id: _id, ...rest, actorName: r.actorId ? names.get(String(r.actorId)) ?? null : null };
  });
  return { data, total, page: query.page, limit: query.limit };
}
