import { Router } from 'express';
import { createMasterRouter } from '../../core/masters/router.js';
import * as C from './cargo.service.js';

const router = Router();
router.use('/product-groups', createMasterRouter(C.productGroupDefinition));
router.use('/products', createMasterRouter(C.productDefinition));
router.use('/load-types', createMasterRouter(C.loadTypeDefinition));
router.use('/shortage-policies', createMasterRouter(C.shortagePolicyDefinition));
router.use('/pod-types', createMasterRouter(C.podTypeDefinition));
export default router;
