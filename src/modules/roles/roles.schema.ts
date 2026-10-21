import { z } from 'zod';
import { baseShape, text, toUpdateSchema } from '../../core/masters/zod.js';

export const PERMISSION_ACTIONS = ['*', 'read', 'create', 'update', 'archive', 'delete', 'sensitive'] as const;

const permission = z.strictObject({
  resource: z.string().trim().min(1).max(60),
  actions: z.array(z.enum(PERMISSION_ACTIONS)).min(1).max(7).refine((a) => new Set(a).size === a.length, 'Actions must be unique'),
});

export const roleShape = {
  key: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_-]{1,39}$/, 'Lowercase letters, digits, "-" or "_"'),
  name: text(80),
  description: text(500).optional(),
  permissions: z.array(permission).max(200),
  ...baseShape,
};
export const createRoleSchema = z.strictObject(roleShape);
export const updateRoleSchema = toUpdateSchema(roleShape);
