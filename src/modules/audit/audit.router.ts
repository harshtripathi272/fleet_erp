import { Router } from 'express';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { auditEntities, auditPeople, exportAuditLogs, listAuditLogs } from './audit.controller.js';
import { auditExportSchema, auditQuerySchema } from './audit.schema.js';

/** The whole company's change history. Mounted at /api/v1/audit-logs behind `authenticate`. */
const router = Router();
const read = authorize('audit-logs', 'read');
router.get('/people', read, auditPeople);
router.get('/entities', read, auditEntities);
router.get('/export', read, validate({ query: auditExportSchema }), exportAuditLogs);
router.get('/', read, validate({ query: auditQuerySchema }), listAuditLogs);
export default router;
