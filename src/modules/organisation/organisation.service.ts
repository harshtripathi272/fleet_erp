import { Types } from 'mongoose';
import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors/index.js';
import { defineMaster } from '../../core/masters/define.js';
import { GROUPS } from '../../core/masters/groups.js';
import { idQuery } from '../../core/masters/query.js';
import { getMaster, listMasters } from '../../core/masters/registry.js';
import { setCodeGenerator } from '../../core/masters/service.js';
import type { MasterDefinition, Plain } from '../../core/masters/types.js';
import { audit } from '../../core/masters/audit.js';
import { ApprovalPolicy, APPROVAL_SUBJECTS } from './models/approvalPolicy.model.js';
import { BRANCH_TYPES, Branch } from './models/branch.model.js';
import { NumberingSeries } from './models/numberingSeries.model.js';
import * as S from './organisation.schema.js';

const byId = (field: string) => ({ schema: idQuery, apply: (v: string) => ({ [field]: new Types.ObjectId(v) }), description: `Only records with this ${field}` });

/* ---------- Branches ---------- */

async function assertNoCycle(id: string | undefined, parentId: unknown) {
  if (!parentId) return;
  if (id && String(parentId) === id) throw new ValidationError('A branch cannot be its own parent', { parentBranchId: ['Same as this branch'] });
  let cursor: unknown = parentId;
  for (let depth = 0; cursor && depth < 25; depth += 1) {
    const parent = await Branch.findById(cursor).select('parentBranchId').lean();
    if (!parent) return;
    if (id && String(parent.parentBranchId) === id) throw new ValidationError('This parent would create a loop', { parentBranchId: ['Creates a cycle'] });
    cursor = parent.parentBranchId;
  }
}

export const branchDefinition = defineMaster({
  key: 'branches', label: 'Branches', singular: 'Branch', group: GROUPS.organisation,
  description: 'Head office, branches, yards, workshops and depots. Only one active head office; parents cannot form loops.',
  model: Branch, createSchema: S.createBranchSchema, updateSchema: S.updateBranchSchema,
  refs: [
    { path: 'parentBranchId', target: 'branches' }, { path: 'placeId', target: 'places' }, { path: 'address.cityId', target: 'cities' },
    { path: 'managerUserId', target: 'users' }, { path: 'cashLimit.currencyId', target: 'currencies' },
  ],
  filters: {
    type: { schema: z.enum(BRANCH_TYPES), apply: (v: string) => ({ type: v }), description: 'Branch type' },
    parentBranchId: byId('parentBranchId'),
  },
  async prepare(data: Plain, ctx) {
    await assertNoCycle(ctx.id, data.parentBranchId);
    return data;
  },
});

/* ---------- Numbering series ---------- */

export const DOCUMENT_SERIES = ['trips', 'fund-requests', 'expenses', 'settlements', 'invoices', 'nominations', 'consignments'];
const TOKEN = /\{(PREFIX|YYYY|YY|MM|BR|SEQ)\}/g;

export function seriesEntities(): string[] {
  return [...listMasters().filter((m) => m.autoCode).map((m) => m.key), ...DOCUMENT_SERIES];
}

function resetKey(policy: string, now: Date) {
  if (policy === 'never') return 'all';
  const year = String(now.getUTCFullYear());
  return policy === 'yearly' ? year : `${year}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function renderSeries(series: { pattern: string; prefix?: string; padding?: number }, number: number, branchCode = '', now = new Date()) {
  return series.pattern.replace(TOKEN, (_m, token: string) => {
    switch (token) {
      case 'PREFIX': return series.prefix ?? '';
      case 'YYYY': return String(now.getUTCFullYear());
      case 'YY': return String(now.getUTCFullYear()).slice(-2);
      case 'MM': return String(now.getUTCMonth() + 1).padStart(2, '0');
      case 'BR': return branchCode;
      default: return String(number).padStart(series.padding ?? 4, '0');
    }
  });
}

function checkPattern(data: Plain) {
  const pattern = String(data.pattern);
  const errors: string[] = [];
  if (!pattern.includes('{SEQ}')) errors.push('Must contain {SEQ}');
  if ((pattern.match(/\{SEQ\}/g) ?? []).length > 1) errors.push('Use {SEQ} once');
  const leftover = pattern.replace(TOKEN, '');
  if (/[{}]/.test(leftover)) errors.push('Unknown token; use {PREFIX}, {YYYY}, {YY}, {MM}, {BR} or {SEQ}');
  if (!/^[A-Za-z0-9._\-/]*$/.test(leftover)) errors.push('Literal text may use letters, digits, ".", "_", "-" and "/"');
  if (pattern.includes('{BR}') && !data.branchId) errors.push('{BR} needs a branch');
  const sample = renderSeries(data as { pattern: string; prefix?: string; padding?: number }, Number(data.nextNumber ?? 1), 'BRANCH');
  if (sample.length > 32) errors.push(`Codes would be ${sample.length} characters; the maximum is 32`);
  if (errors.length) throw new ValidationError('Numbering pattern is not valid', { pattern: errors });
}

export const numberingSeriesDefinition = defineMaster({
  key: 'numbering-series', label: 'Numbering series', singular: 'Numbering series', group: GROUPS.organisation,
  description: 'How codes and document numbers are generated, e.g. {PREFIX}/{YY}/{SEQ} → DRV/26/0001. Resets yearly, monthly or never.',
  model: NumberingSeries, createSchema: S.createNumberingSeriesSchema, updateSchema: S.updateNumberingSeriesSchema,
  searchFields: ['code', 'name', 'entity'],
  sortFields: ['code', 'name', 'entity', 'createdAt', 'updatedAt'],
  refs: [{ path: 'branchId', target: 'branches' }],
  labels: { entity: 'Numbers', padding: 'Digits in the running number', nextNumber: 'Next running number' },
  hints: {
    entity: 'What it numbers: a master such as drivers, or a document such as trips.',
    pattern: '{PREFIX} the prefix, {YYYY} or {YY} the year, {MM} the month, {BR} the branch code, {SEQ} the running number. DRV/{YY}/{SEQ} gives DRV/26/0001.',
    padding: 'The running number is filled with zeros to this many digits: 4 gives 0001.',
    resetPolicy: 'When the running number starts again from 1.',
  },
  filters: { entity: { schema: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/), apply: (v: string) => ({ entity: v }), description: 'Series for this master or document' } },
  customFields: false,
  async prepare(data: Plain) {
    const allowed = seriesEntities();
    if (!allowed.includes(String(data.entity))) {
      throw new ValidationError('This master or document does not use numbering', { entity: [`Use one of: ${allowed.join(', ')}`] });
    }
    checkPattern(data);
    return data;
  },
});

async function branchCodeOf(branchId: unknown) {
  if (!branchId) return '';
  const branch = await Branch.findById(branchId).select('code').lean();
  return branch ? String(branch.code) : '';
}

/** Takes the next number atomically, resetting it when the year or month changes. */
async function consume(seriesId: unknown): Promise<{ code: string; number: number }> {
  const series = await NumberingSeries.findById(seriesId).lean();
  if (!series) throw new NotFoundError('Numbering series not found');
  const now = new Date();
  const key = resetKey(String(series.resetPolicy), now);
  if (series.lastResetKey !== key) {
    await NumberingSeries.updateOne({ _id: series._id, lastResetKey: series.lastResetKey ?? null }, { $set: { lastResetKey: key, nextNumber: series.lastResetKey ? 1 : series.nextNumber } });
  }
  const before = await NumberingSeries.findOneAndUpdate({ _id: series._id }, { $inc: { nextNumber: 1 } }, { returnDocument: 'before' }).lean();
  const number = Number(before!.nextNumber);
  return { code: renderSeries(series as unknown as { pattern: string; prefix?: string; padding?: number }, number, await branchCodeOf(series.branchId), now), number };
}

async function activeSeriesFor(entity: string, branchIds: unknown) {
  const branches = Array.isArray(branchIds) ? branchIds : [];
  if (branches.length === 1) {
    const branchSeries = await NumberingSeries.findOne({ entity, branchId: branches[0], status: 'active' }).lean();
    if (branchSeries) return branchSeries;
  }
  return NumberingSeries.findOne({ entity, branchId: { $exists: false }, status: 'active' }).lean();
}

/** Code generator used by masters with autoCode; skips numbers already taken by hand-typed codes. */
export async function nextCodeFor(entity: string, data: Plain): Promise<string | null> {
  const series = await activeSeriesFor(entity, data.branchIds);
  if (!series) return null;
  const master = getMaster(entity);
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const { code } = await consume(series._id);
    if (!master || !(await master.model.exists({ code }).collation({ locale: 'en', strength: 2 }))) return code;
  }
  throw new ConflictError('Could not find a free code in this numbering series; raise its next number');
}
setCodeGenerator(nextCodeFor);

export async function previewSeries(id: string) {
  const series = await NumberingSeries.findById(id).lean();
  if (!series) throw new NotFoundError('Numbering series not found');
  const key = resetKey(String(series.resetPolicy), new Date());
  const number = series.lastResetKey && series.lastResetKey !== key ? 1 : Number(series.nextNumber);
  return { next: renderSeries(series as unknown as { pattern: string; prefix?: string; padding?: number }, number, await branchCodeOf(series.branchId)), number, entities: seriesEntities() };
}

/** Reserves the next number for a document (e.g. a trip number). */
export async function reserveSeries(id: string, actorId?: string, requestId?: string) {
  const series = await NumberingSeries.findById(id).select('status').lean();
  if (!series) throw new NotFoundError('Numbering series not found');
  if (series.status !== 'active') throw new ConflictError('Only an active series can issue numbers');
  const result = await consume(id);
  await audit({ entity: 'numbering-series', entityId: id, action: 'custom', summary: `Issued ${result.code}`, actorId, requestId });
  return result;
}

/* ---------- Approval policies ---------- */

export const approvalPolicyDefinition = defineMaster({
  key: 'approval-policies', label: 'Approval policies', singular: 'Approval policy', group: GROUPS.organisation,
  description: 'Who approves what above which amount. Levels run 1, 2, 3… with rising thresholds; each names a role or a person.',
  model: ApprovalPolicy, createSchema: S.createApprovalPolicySchema, updateSchema: S.updateApprovalPolicySchema,
  searchFields: ['code', 'name', 'subject'],
  refs: [{ path: 'currencyId', target: 'currencies' }, { path: 'levels.approverRoleId', target: 'roles' }, { path: 'levels.approverUserId', target: 'users' }],
  choiceLabels: { 'levels.channels': { app: 'In the app', whatsapp: 'WhatsApp', sms: 'SMS', email: 'E-mail' } },
  hints: {
    'levels.minAmountMinor': 'The level applies to requests from this amount (or these litres) up. Level 1 usually starts at 0.',
    'levels.escalateAfterHours': 'If nobody at this level decides a fuel request, advance or expense within these hours, it moves to the next level up, and that level is told. Nights and weekends count. Empty: it waits here until someone decides.',
    'levels.channels': 'Approvers always see a waiting request in the app. WhatsApp also sends them Approve and Reject buttons; SMS and e-mail tell them to open the app, and go out through the connections under Sending messages.',
  },
  labels: { 'levels.minAmountMinor': 'Applies from', 'levels.measure': 'Measured in', 'levels.escalateAfterHours': 'Escalate after (hours)', 'levels.approverUserId': 'Approver (a person instead of a role)' },
  filters: { subject: { schema: z.enum(APPROVAL_SUBJECTS), apply: (v: string) => ({ subject: v }), description: 'What is being approved' } },
  async prepare(data: Plain) {
    const levels = data.levels as Array<{ level: number; minAmountMinor: number; approverRoleId?: unknown; approverUserId?: unknown }>;
    const errors: string[] = [];
    levels.forEach((l, i) => {
      if (l.level !== i + 1) errors.push(`Level ${i + 1}: levels must be numbered 1, 2, 3… in order`);
      if (!l.approverRoleId === !l.approverUserId) errors.push(`Level ${l.level}: name exactly one approver role or approver user`);
      if (i > 0 && l.minAmountMinor <= levels[i - 1]!.minAmountMinor) errors.push(`Level ${l.level}: threshold must be higher than level ${l.level - 1}`);
    });
    if (errors.length) throw new ValidationError('Approval levels are not valid', { levels: errors });
    return data;
  },
});

export const masters: MasterDefinition[] = [branchDefinition, numberingSeriesDefinition, approvalPolicyDefinition];
