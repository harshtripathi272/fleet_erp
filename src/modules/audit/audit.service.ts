import mongoose, { Types } from 'mongoose';
import { AuditLog } from '../../core/masters/audit.model.js';
import { comparable } from '../../core/masters/audit.js';
import { singular } from '../../core/masters/labels.js';
import { getMaster, getRefTarget } from '../../core/masters/registry.js';
import type { Action, Plain } from '../../core/masters/types.js';
import { User } from '../users/user.model.js';
import type { AuditQuery } from './audit.schema.js';

/** Who is reading: masked values follow their `sensitive` permission on each master. */
export interface AuditReader {
  can: (resource: string, action: Action) => boolean;
}

interface Change { path: string; from?: unknown; to?: unknown }
interface Row { _id: unknown; entity: string; entityId: unknown; action: string; summary?: string; actorId?: unknown; at: Date; changes?: Change[] }
export interface Entry {
  id: unknown; entity: string; entityId: unknown; action: string; summary?: string; actorId?: string; at: string;
  actorName: string | null; entityLabel: string; title: string | null; openable: boolean; changes: Change[];
}

/** The most entries one CSV download carries. */
export const EXPORT_LIMIT = 10_000;
const HIDDEN = '[hidden]';

function filterOf(query: Partial<AuditQuery>): Plain {
  const filter: Plain = {};
  if (query.entity) filter.entity = query.entity;
  if (query.entityId) filter.entityId = new Types.ObjectId(query.entityId);
  if (query.actorId) filter.actorId = new Types.ObjectId(query.actorId);
  if (query.action) filter.action = query.action;
  if (query.from || query.to) filter.at = { ...(query.from ? { $gte: query.from } : {}), ...(query.to ? { $lte: endOfDay(query.to) } : {}) };
  return filter;
}

/** A date with no time means the whole day: "to 4 Nov" includes changes made on 4 Nov. */
function endOfDay(value: Date | string) {
  const d = new Date(value);
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0) d.setUTCHours(23, 59, 59, 999);
  return d;
}

const humanise = (key: string) => key.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** "Drivers" → the master's singular ("Driver"); records that are not masters get a readable name from their key. */
export const entityLabel = (entity: string) => getMaster(entity)?.singular ?? singular(getRefTarget(entity)?.label ?? humanise(entity));

/** Does this path hold a value the reader may not see? */
function masked(entity: string, path: string, reader: AuditReader) {
  const sensitive = getMaster(entity)?.sensitive ?? [];
  if (!sensitive.length || reader.can(entity, 'sensitive')) return false;
  return sensitive.some((s) => s === path || s.startsWith(`${path}.`) || path.startsWith(`${s}.`));
}

/** Each record's title, one query per master: its title field, or its code. Deleted records keep the title their last change had. */
async function titles(rows: Row[]) {
  const out = new Map<string, string>();
  const byEntity = new Map<string, Set<string>>();
  for (const r of rows) byEntity.set(r.entity, (byEntity.get(r.entity) ?? new Set()).add(String(r.entityId)));
  await Promise.all([...byEntity].map(async ([entity, ids]) => {
    // A master names its title field; other records (trips, requests, settlements) have a number.
    const target = getRefTarget(entity);
    const model = target?.model ?? Object.values(mongoose.models).find((m) => m.collection.collectionName === entity.replace(/-/g, ''));
    if (!model) return;
    const field = target?.titleField ?? 'number';
    const docs = await model.find({ _id: { $in: [...ids] } }).select(`${field} number code name`).lean() as Plain[];
    for (const d of docs) {
      const title = d[field] ?? d.number ?? d.name ?? d.code;
      if (title !== undefined && title !== null && title !== '') out.set(`${entity}:${d._id}`, String(title));
    }
  }));
  for (const r of rows) {
    const key = `${r.entity}:${r.entityId}`;
    if (out.get(key)) continue;
    const field = getRefTarget(r.entity)?.titleField ?? 'name';
    // The title field first, then a name, then a code: whichever the record's changes hold.
    const change = [field, 'name', 'code'].map((path) => r.changes?.find((c) => c.path === path)).find(Boolean);
    const value = change?.from ?? change?.to;
    if (value !== undefined && value !== null && value !== HIDDEN) out.set(key, String(value));
  }
  return out;
}

/** Audit entries as the screen shows them: the person's name, the master, the record's title, masked values. */
async function present(rows: Row[], reader: AuditReader): Promise<Entry[]> {
  const actorIds = [...new Set(rows.map((r) => String(r.actorId ?? '')).filter(Boolean))];
  const [actors, named] = await Promise.all([
    User.find({ _id: { $in: actorIds } }).select('name').lean(),
    titles(rows),
  ]);
  const names = new Map(actors.map((a) => [String(a._id), a.name as string]));
  return rows.map((r) => {
    const { _id, changes = [], ...rest } = comparable(r) as Row & { at: string; actorId?: string };
    return {
      id: _id,
      ...rest,
      actorName: r.actorId ? names.get(String(r.actorId)) ?? 'A removed user' : null,
      entityLabel: entityLabel(r.entity),
      title: named.get(`${r.entity}:${r.entityId}`) ?? null,
      // Masters the reader may open; other records (trips, documents) are shown by name only.
      openable: Boolean(getMaster(r.entity)) && r.action !== 'delete' && reader.can(r.entity, 'read'),
      changes: changes.map((c) => (masked(r.entity, c.path, reader) ? { ...c, from: c.from === undefined ? undefined : HIDDEN, to: c.to === undefined ? undefined : HIDDEN } : c)),
    };
  });
}

export async function listAuditLogs(query: AuditQuery, reader: AuditReader) {
  const filter = filterOf(query);
  const [rows, total] = await Promise.all([
    AuditLog.find(filter).sort({ at: -1, _id: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
    AuditLog.countDocuments(filter),
  ]);
  return { data: await present(rows as unknown as Row[], reader), total, page: query.page, limit: query.limit };
}

/** The people who appear in the log, for the screen's filter, so reading it needs no access to users. */
export async function auditPeople() {
  const ids = (await AuditLog.distinct('actorId', { actorId: { $ne: null } })) as Types.ObjectId[];
  const users = await User.find({ _id: { $in: ids } }).select('name').sort({ name: 1 }).lean();
  return users.map((u) => ({ id: String(u._id), name: u.name as string }));
}

/** The masters (and other records) that appear in the log, for the screen's filter. */
export async function auditEntities() {
  const keys = (await AuditLog.distinct('entity')) as string[];
  return keys.map((key) => ({ key, label: getMaster(key)?.label ?? getRefTarget(key)?.label ?? humanise(key) })).sort((a, b) => a.label.localeCompare(b.label));
}

const cell = (value: unknown) => {
  const text = value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  // Quote every cell; a leading = + - @ would be read as a formula by a spreadsheet.
  return `"${(/^[=+\-@\t\r]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
};

/** The current filter as CSV, one row per changed field, for an accountant. Masked like the screen. */
export async function exportCsv(query: Partial<AuditQuery>, reader: AuditReader) {
  const rows = await AuditLog.find(filterOf(query)).sort({ at: -1, _id: -1 }).limit(EXPORT_LIMIT).lean();
  const entries = await present(rows as unknown as Row[], reader);
  const lines = [['When', 'Who', 'Master', 'Record', 'Action', 'Summary', 'Field', 'Before', 'After'].map(cell).join(',')];
  for (const e of entries) {
    const base = [e.at, e.actorName ?? 'System', e.entityLabel, e.title ?? '', e.action, e.summary ?? ''];
    const changes = e.changes;
    if (!changes.length) lines.push([...base, '', '', ''].map(cell).join(','));
    for (const c of changes) lines.push([...base, c.path, c.from, c.to].map(cell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
