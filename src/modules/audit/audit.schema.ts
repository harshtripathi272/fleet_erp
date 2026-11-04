import { z } from 'zod';
import { isoDate, objectId } from '../../core/masters/zod.js';

export const auditQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  entity: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/).optional(),
  entityId: objectId.optional(),
  actorId: objectId.optional(),
  action: z.enum(['create', 'update', 'archive', 'restore', 'delete', 'custom']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

/** The same filters, without paging: the download carries every matching entry (up to 10,000). */
export const auditExportSchema = auditQuerySchema.omit({ page: true, limit: true });
export type AuditExportQuery = z.infer<typeof auditExportSchema>;
