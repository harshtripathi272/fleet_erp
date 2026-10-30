import { Router } from 'express';
import { authorize } from '../../middleware/authorize.js';
import * as MetaController from './meta.controller.js';

const router = Router();
router.get('/masters', MetaController.masters);
router.get('/overview', MetaController.overview);
router.get('/stats', MetaController.stats);
router.get('/outbox', authorize('users', 'update'), MetaController.outbox);
router.post('/sample-data', authorize('company', 'update'), MetaController.sampleData);
export default router;

/** Model definitions without sign-in, for the models reference page. No records, only structure. */
export const publicMetaRouter = Router();
publicMetaRouter.get('/models', MetaController.models);
