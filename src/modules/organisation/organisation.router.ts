import { Router } from 'express';
import { createMasterRouter } from '../../core/masters/router.js';
import { idParams } from '../../core/masters/zod.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import * as OrganisationController from './organisation.controller.js';
import * as O from './organisation.service.js';

const router = Router();
router.use('/branches', createMasterRouter(O.branchDefinition));
router.use('/numbering-series', createMasterRouter(O.numberingSeriesDefinition, (r) => {
  r.get('/entities', authorize('numbering-series', 'read'), OrganisationController.seriesEntities);
  r.get('/:id/preview', authorize('numbering-series', 'read'), validate({ params: idParams }), OrganisationController.previewSeries);
  r.post('/:id/next', authorize('numbering-series', 'update'), validate({ params: idParams }), OrganisationController.reserveSeries);
}));
router.use('/approval-policies', createMasterRouter(O.approvalPolicyDefinition));
export default router;
