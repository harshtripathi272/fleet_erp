import { Router } from 'express';
import { createMasterRouter } from '../../core/masters/router.js';
import * as D from './drivers.service.js';

const router = Router();
router.use('/licence-classes', createMasterRouter(D.licenceClassDefinition));
router.use('/drivers', createMasterRouter(D.driverDefinition));
router.use('/recovery-rules', createMasterRouter(D.recoveryRuleDefinition));
export default router;
