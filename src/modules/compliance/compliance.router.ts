import { Router } from 'express';
import { createMasterRouter } from '../../core/masters/router.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import * as ComplianceController from './compliance.controller.js';
import { checkQuerySchema, expiringQuerySchema } from './compliance.schema.js';
import * as C from './compliance.service.js';

const router = Router();
router.use('/document-types', createMasterRouter(C.documentTypeDefinition));
router.use('/permit-types', createMasterRouter(C.permitTypeDefinition));
router.use('/insurance-types', createMasterRouter(C.insuranceTypeDefinition));
router.use('/compliance-documents', createMasterRouter(C.complianceDocumentDefinition, (r) => {
  r.get('/expiring', authorize('compliance-documents', 'read'), validate({ query: expiringQuerySchema }), ComplianceController.expiring);
  r.get('/check', authorize('compliance-documents', 'read'), validate({ query: checkQuerySchema }), ComplianceController.check);
}));
export default router;
