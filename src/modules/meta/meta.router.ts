import { Router } from 'express';
import { z } from 'zod';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { MAX_ROWS } from '../../core/masters/import.js';
import { layoutInputSchema } from '../../core/masters/layout.js';
import * as MetaController from './meta.controller.js';

const router = Router();
router.get('/masters', MetaController.masters);
router.get('/overview', MetaController.overview);
router.get('/stats', MetaController.stats);
router.get('/readiness', authorize('company', 'read'), MetaController.readiness);
router.get('/areas', MetaController.areas);
router.get('/outbox', authorize('users', 'update'), MetaController.outbox);
/** `full` (default): ten trucks with trips at every stage. `small`: the masters with two trucks, which the tests use. */
const sampleBody = z.strictObject({ size: z.enum(['small', 'full']).default('full') }).default({ size: 'full' });
router.post('/sample-data', authorize('company', 'update'), validate({ body: sampleBody }), MetaController.sampleData);
/** Loading a master from a spreadsheet: the columns, a CSV template, and a dry run or load of up to 500 rows at a time. */
const importParams = z.strictObject({ master: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/) });
const importBody = z.strictObject({
  rows: z.array(z.record(z.string().max(200), z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]).transform((v) => (v == null ? '' : String(v))))).min(1).max(MAX_ROWS),
  dryRun: z.boolean().default(true),
  firstRow: z.number().int().min(2).max(1_000_000).optional(),
});
// The master of masters (#65): a company's own shape for each master.
router.get('/layouts/:master', authorize('company', 'read'), validate({ params: importParams }), MetaController.getLayout);
router.put('/layouts/:master', authorize('company', 'update'), validate({ params: importParams, body: layoutInputSchema }), MetaController.saveLayout);
router.get('/import/:master', validate({ params: importParams }), MetaController.importInfo);
router.get('/import/:master/template', validate({ params: importParams }), MetaController.importTemplate);
router.post('/import/:master', validate({ params: importParams, body: importBody }), MetaController.importRun);
export default router;

/** Model definitions without sign-in, for the models reference page. No records, only structure. */
export const publicMetaRouter = Router();
publicMetaRouter.get('/models', MetaController.models);
