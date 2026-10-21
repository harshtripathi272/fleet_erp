import { Router } from 'express';
import { createMasterRouter } from '../../core/masters/router.js';
import * as P from './parties.service.js';

const router = Router();
router.use('/parties', createMasterRouter(P.partyDefinition));
router.use('/order-sources', createMasterRouter(P.orderSourceDefinition));
export default router;
