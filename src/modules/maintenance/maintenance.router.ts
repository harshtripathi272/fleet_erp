import { Router } from 'express';
import { createMasterRouter } from '../../core/masters/router.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { requireArea } from '../company/areas.js';
import * as C from './maintenance.controller.js';
import { costsQuery } from './maintenance.schema.js';
import * as M from './maintenance.service.js';

const router = Router();
router.use('/service-plans', createMasterRouter(M.servicePlanDefinition));
router.use('/work-orders', createMasterRouter(M.workOrderDefinition));
router.use('/tyre-records', createMasterRouter(M.tyreRecordDefinition));
const area = requireArea('maintenance');
router.get('/maintenance/services', area, authorize('work-orders', 'read'), C.services);
router.get('/maintenance/held-trucks', area, authorize('work-orders', 'read'), C.held);
router.get('/maintenance/costs', area, authorize('work-orders', 'read'), validate({ query: costsQuery }), C.costs);
export default router;
