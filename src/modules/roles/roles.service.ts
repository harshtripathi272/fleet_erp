import { ConflictError, ValidationError } from '../../core/errors/index.js';
import { listMasters } from '../../core/masters/registry.js';
import { GROUPS } from '../../core/masters/groups.js';
import type { MasterDefinition, Plain } from '../../core/masters/types.js';
import { Role } from './role.model.js';
import { assertCanGrantPermissions, permissionsOf } from './grants.js';
import { createRoleSchema, updateRoleSchema } from './roles.schema.js';

/** Resources that are not masters but carry permissions. */
export const EXTRA_RESOURCES = ['company', 'audit-logs'];

export function knownResources(): string[] {
  return ['*', ...listMasters().map((m) => m.key), ...EXTRA_RESOURCES];
}

const groupKeys = (...groups: string[]) => listMasters().filter((m) => groups.includes(m.group)).map((m) => m.key);
const write = (keys: string[]) => keys.map((resource) => ({ resource, actions: ['create', 'update', 'archive'] }));

/** Built-in roles. Their permissions are re-applied at every start-up. */
export function systemRoles() {
  return [
    { key: 'owner', name: 'Owner', description: 'Full access, including users and roles. At least one active owner must remain.', permissions: [{ resource: '*', actions: ['*'] }] },
    { key: 'admin', name: 'Administrator', description: 'Full access to every master, users and roles.', permissions: [{ resource: '*', actions: ['*'] }] },
    {
      key: 'operations', name: 'Operations', description: 'Reads everything; maintains fleet, drivers, places, cargo and trip settings.',
      permissions: [{ resource: '*', actions: ['read'] }, ...write(groupKeys(GROUPS.geography, GROUPS.fleet, GROUPS.drivers, GROUPS.compliance, GROUPS.cargo, GROUPS.trips, GROUPS.parties))],
    },
    {
      key: 'finance', name: 'Finance', description: 'Reads everything including sensitive fields; maintains money, parties and trip budgets.',
      permissions: [{ resource: '*', actions: ['read', 'sensitive'] }, ...write(groupKeys(GROUPS.money, GROUPS.parties)), ...write(['expense-categories', 'expense-items', 'trip-budgets', 'advance-policies', 'approval-policies'])],
    },
    { key: 'viewer', name: 'Viewer', description: 'Read-only access to every master.', permissions: [{ resource: '*', actions: ['read'] }] },
  ];
}

export async function ensureSystemRoles(): Promise<void> {
  for (const role of systemRoles()) {
    await Role.updateOne(
      { key: role.key },
      { $set: { name: role.name, description: role.description, permissions: role.permissions, isSystem: true }, $setOnInsert: { key: role.key, status: 'active', custom: {} } },
      { upsert: true },
    );
  }
}

export const roleDefinition: MasterDefinition = {
  key: 'roles',
  label: 'Roles',
  singular: 'Role',
  group: GROUPS.organisation,
  description: 'A job and the permissions it grants on each master (read, create, update, archive, delete, sensitive).',
  model: Role,
  createSchema: createRoleSchema,
  updateSchema: updateRoleSchema,
  searchFields: ['key', 'name'],
  sortFields: ['name', 'key', 'createdAt', 'updatedAt'],
  immutable: ['key'],
  customFields: false,
  async prepare(data: Plain, ctx) {
    if (ctx.mode === 'update' && ctx.existing?.isSystem) throw new ConflictError('Built-in roles cannot be edited. Create a new role instead.');
    const known = new Set(knownResources());
    const unknown = ((data.permissions ?? []) as Array<{ resource: string }>).map((p) => p.resource).filter((r) => !known.has(r));
    if (unknown.length) throw new ValidationError('Unknown permission resources', { permissions: unknown.map((r) => `Unknown resource "${r}"`) });
    const resources = ((data.permissions ?? []) as Array<{ resource: string }>).map((p) => p.resource);
    if (new Set(resources).size !== resources.length) throw new ValidationError('Each resource may appear only once', { permissions: ['Duplicate resource'] });
    await assertCanGrantPermissions(ctx.actorId, permissionsOf(data));
    return { ...data, isSystem: false };
  },
  async beforeArchive(doc) {
    if (doc.isSystem) throw new ConflictError('Built-in roles cannot be archived');
  },
  async beforeDelete(doc) {
    if (doc.isSystem) throw new ConflictError('Built-in roles cannot be deleted');
  },
};
