import { Router } from 'express';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { listAuditLogs } from './audit.controller.js';
import { auditQuerySchema } from './audit.schema.js';

const router = Router();
router.get('/', authorize('audit-logs', 'read'), validate({ query: auditQuerySchema }), listAuditLogs);
export default router;
