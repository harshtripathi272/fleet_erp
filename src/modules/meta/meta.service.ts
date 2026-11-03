import type { Router } from 'express';
import type { Schema, SchemaType } from 'mongoose';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { getRedis } from '../../core/cache/redis.js';
import { mongoState } from '../../core/db/mongo.js';
import { recentMail } from '../../core/mail/mailer.js';
import { GROUPS } from '../../core/masters/groups.js';
import { listMasters as registered, refsOf } from '../../core/masters/registry.js';
import { ACTIONS, type MasterDefinition, type Plain } from '../../core/masters/types.js';
import type { AuthContext } from '../../types/express.js';
import { withChoices } from '../configuration/configuration.service.js';
import { FieldDefinition } from '../configuration/models/configuration.model.js';

const GROUP_ORDER: string[] = Object.values(GROUPS);
/** Masters in catalogue order (MF-SPEC-01 section 8), not import order. */
const listMasters = () => [...registered()].sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));

const SYSTEM_FIELDS = new Set(['_id', 'version', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'archivedAt', 'archivedBy', 'archiveReason']);
const BASE_FIELDS = new Set(['status', 'validFrom', 'validTo', 'branchIds', 'tags', 'notes', 'externalRefs', 'attachments', 'custom']);

interface FieldInfo {
  path: string;
  type: string;
  array: boolean;
  required: boolean;
  enum?: string[];
  ref?: string;
  default?: unknown;
  group: 'master' | 'standard' | 'system';
  sensitive?: boolean;
  hidden?: boolean;
  immutable?: boolean;
  min?: number;
  max?: number;
}

/** Mongoose model name → master key, so field refs point at endpoints. */
function modelKeyMap() {
  return new Map(listMasters().map((m) => [m.model.modelName, m.key]));
}

function describeSchema(schema: Schema, def: MasterDefinition, keys: Map<string, string>, prefix = '', out: FieldInfo[] = []): FieldInfo[] {
  schema.eachPath((path: string, type: SchemaType) => {
    const full = prefix ? `${prefix}.${path}` : path;
    const top = full.split('.')[0]!;
    const options = (type as unknown as { options: Plain }).options ?? {};
    // Mongoose 9 keeps an array's element type on `embeddedSchemaType`; older versions used `caster`.
    const caster = (type as unknown as { embeddedSchemaType?: { instance?: string; options?: Plain }; caster?: { instance?: string; options?: Plain } }).embeddedSchemaType
      ?? (type as unknown as { caster?: { instance?: string; options?: Plain } }).caster;
    const subSchema = (type as unknown as { schema?: Schema }).schema;
    const instance = type.instance;
    const array = instance === 'Array' || instance === 'DocumentArray';
    const refModel = (options.ref ?? caster?.options?.ref) as string | undefined;
    const enumValues = ((type as unknown as { enumValues?: string[] }).enumValues?.length ? (type as unknown as { enumValues: string[] }).enumValues : (caster as { enumValues?: string[] } | undefined)?.enumValues) ?? (Array.isArray(options.enum) ? options.enum as string[] : undefined);
    const info: FieldInfo = {
      path: full,
      type: subSchema ? 'object' : array ? (caster?.instance ?? 'Mixed').toLowerCase() : instance.toLowerCase(),
      array,
      required: Boolean(options.required),
      group: SYSTEM_FIELDS.has(top) ? 'system' : BASE_FIELDS.has(top) ? 'standard' : 'master',
    };
    if (enumValues?.length) info.enum = enumValues;
    if (refModel) info.ref = keys.get(refModel) ?? refModel;
    else { const declared = refsOf(def).find((r) => r.path === full && !r.usageOnly); if (declared) info.ref = declared.target; }
    if (options.default !== undefined && typeof options.default !== 'function') info.default = options.default;
    if (typeof options.min === 'number') info.min = options.min;
    if (typeof options.max === 'number') info.max = options.max;
    if (def.sensitive?.includes(full)) info.sensitive = true;
    if (def.hidden?.includes(full) || full === 'geo' || full.startsWith('geo.')) info.hidden = true;
    if (def.immutable?.includes(full)) info.immutable = true;
    out.push(info);
    if (subSchema) describeSchema(subSchema, def, keys, full, out);
  });
  return out.filter((f) => f.path !== '_id' && !f.path.endsWith('._id'));
}

const toJson = (schema: z.ZodType | undefined) => {
  if (!schema) return undefined;
  try {
    return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  } catch {
    return undefined;
  }
};

interface Endpoint { method: string; path: string; permission?: string; rateLimits: Plain[]; authenticated: boolean; schemas: Record<string, unknown>; }

interface RouterLike { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: { meta?: Plain } }> } }> }

/** Reads routes and the metadata attached to their middleware (permission, rate limit, schemas). */
export function endpointsOf(router: Router, prefix: string, mountAuthenticated: boolean): Endpoint[] {
  const out: Endpoint[] = [];
  for (const layer of (router as unknown as RouterLike).stack) {
    if (!layer.route) continue;
    const metas = layer.route.stack.map((l) => l.handle.meta ?? {});
    const permission = metas.find((m) => m.permission)?.permission as { resource: string; action: string } | undefined;
    const schemas = (metas.find((m) => m.schemas)?.schemas ?? {}) as Record<string, z.ZodType>;
    for (const method of Object.keys(layer.route.methods).filter((m) => layer.route!.methods[m])) {
      out.push({
        method: method.toUpperCase(),
        path: `${prefix}${layer.route.path === '/' ? '' : layer.route.path}`,
        permission: permission ? `${permission.resource}:${permission.action}` : undefined,
        rateLimits: metas.filter((m) => m.rateLimit).map((m) => m.rateLimit as Plain),
        authenticated: mountAuthenticated || metas.some((m) => m.authenticated),
        schemas: Object.fromEntries(Object.entries(schemas).map(([k, s]) => [k, toJson(s)])),
      });
    }
  }
  return out;
}

function permissionsFor(def: MasterDefinition, auth?: AuthContext) {
  return Object.fromEntries(ACTIONS.map((a) => [a, auth?.can(def.key, a) ?? false]));
}

export async function describeMasters(auth?: AuthContext) {
  const keys = modelKeyMap();
  const customFields = await withChoices(await FieldDefinition.find({ status: 'active' }).sort({ order: 1 }).lean() as Plain[]);
  return listMasters().map((def) => ({
    key: def.key,
    label: def.label,
    singular: def.singular,
    group: def.group,
    description: def.description,
    collection: def.model.collection.collectionName,
    basePath: `/api/v1/${def.key === 'custom-records' ? 'custom-masters/:masterId/records' : def.key}`,
    titleField: def.titleField ?? 'name',
    columns: def.columns ?? [],
    searchFields: def.searchFields,
    sortFields: def.sortFields,
    defaultSort: def.defaultSort ?? null,
    autoCode: Boolean(def.autoCode),
    customFieldsAllowed: def.customFields !== false,
    managed: def.managed ?? {},
    sensitive: def.sensitive ?? [],
    immutable: def.immutable ?? [],
    filters: Object.entries(def.filters ?? {}).map(([key, f]) => ({ key, description: f.description, schema: toJson(f.schema) })),
    references: refsOf(def).map((r) => ({ path: r.path, target: r.target, ...(r.partyRoles ? { partyRoles: r.partyRoles } : {}), ...(r.usageOnly ? { usageOnly: true } : {}) })),
    fields: describeSchema(def.model.schema, def, keys),
    customFields: customFields.filter((f) => f.entity === def.key).map((f) => ({
      key: f.key, label: f.label, type: f.type, required: f.required,
      ...(f.choices ? { choices: f.choices } : {}), ...(f.referenceMaster ? { referenceMaster: f.referenceMaster } : {}), ...(f.helpText ? { helpText: f.helpText } : {}),
    })),
    indexes: def.model.schema.indexes().map(([fields, options]) => ({ fields, unique: Boolean(options.unique), partial: options.partialFilterExpression ?? null })),
    createSchema: toJson(def.createSchema),
    updateSchema: toJson(def.updateSchema),
    endpoints: def.router ? endpointsOf(def.router, `/api/v1/${def.key}`, true) : [],
    permissions: permissionsFor(def, auth),
  }));
}

export function limits() {
  return {
    bodyLimit: '1 MB',
    pageSize: { default: 20, max: 100 },
    searchLength: 100,
    accessTokenMinutes: env.ACCESS_TOKEN_TTL_SECONDS / 60,
    refreshTokenDays: env.REFRESH_TOKEN_TTL_DAYS,
    passwordResetMinutes: env.PASSWORD_RESET_TTL_MINUTES,
    lockout: { failures: env.LOGIN_MAX_FAILURES, minutes: env.LOGIN_LOCK_MINUTES },
    password: { min: 8, max: 128, rule: 'At least one letter and one digit' },
    money: 'Amounts are integers in minor units (ngwee, cents) with a currencyId',
    dates: 'YYYY-MM-DD or ISO 8601 with time zone',
    concurrency: 'PATCH must include the record version; a stale version returns 409',
    deletion: 'DELETE only works for records nothing references; otherwise archive',
  };
}

export function system() {
  return {
    environment: env.NODE_ENV,
    mongo: mongoState(),
    redis: env.REDIS_URL ? (getRedis() ? 'connected' : 'disconnected') : 'not configured (in-memory rate limits)',
    smtp: env.SMTP_HOST ? `configured (${env.SMTP_HOST})` : 'not configured (e-mails are logged only)',
    exposeResetToken: env.EXPOSE_RESET_TOKEN,
  };
}

export const outbox = () => recentMail();

/** Record counts per master and status, for the console overview. */
export async function stats() {
  const rows = await Promise.all(listMasters().map(async (def) => {
    const groups = await def.model.aggregate<{ _id: string; n: number }>([{ $group: { _id: '$status', n: { $sum: 1 } } }]);
    const by = Object.fromEntries(groups.map((g) => [g._id ?? 'unknown', g.n]));
    return { key: def.key, label: def.label, group: def.group, active: by.active ?? 0, inactive: by.inactive ?? 0, archived: by.archived ?? 0, total: groups.reduce((s, g) => s + g.n, 0) };
  }));
  return rows;
}
