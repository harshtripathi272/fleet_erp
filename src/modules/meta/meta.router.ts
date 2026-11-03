import { Router } from 'express';
import { z } from 'zod';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import * as MetaController from './meta.controller.js';

const router = Router();
router.get('/masters', MetaController.masters);
router.get('/overview', MetaController.overview);
router.get('/stats', MetaController.stats);
router.get('/outbox', authorize('users', 'update'), MetaController.outbox);
/** `full` (default): ten trucks with trips at every stage. `small`: the masters with two trucks, which the tests use. */
const sampleBody = z.strictObject({ size: z.enum(['small', 'full']).default('full') }).default({ size: 'full' });
router.post('/sample-data', authorize('company', 'update'), validate({ body: sampleBody }), MetaController.sampleData);
export default router;

/** Model definitions without sign-in, for the models reference page. No records, only structure. */
export const publicMetaRouter = Router();
publicMetaRouter.get('/models', MetaController.models);
