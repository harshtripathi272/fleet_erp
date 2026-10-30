import { Router } from 'express';
import { createMasterRouter } from '../../core/masters/router.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import * as TripsController from './trips.controller.js';
import { estimateQuerySchema } from './trips.schema.js';
import * as T from './trips.service.js';

const router = Router();
router.use('/trip-types', createMasterRouter(T.tripTypeDefinition));
router.use('/trip-stages', createMasterRouter(T.tripStageDefinition));
router.use('/stop-types', createMasterRouter(T.stopTypeDefinition));
router.use('/expense-categories', createMasterRouter(T.expenseCategoryDefinition));
router.use('/expense-items', createMasterRouter(T.expenseItemDefinition));
router.use('/fuel-types', createMasterRouter(T.fuelTypeDefinition));
router.use('/fuel-norms', createMasterRouter(T.fuelNormDefinition));
router.use('/trip-budgets', createMasterRouter(T.tripBudgetDefinition, (r) => {
  r.get('/estimate', authorize('trip-budgets', 'read'), validate({ query: estimateQuerySchema }), TripsController.estimate);
}));
router.use('/advance-policies', createMasterRouter(T.advancePolicyDefinition));
router.use('/cancellation-reasons', createMasterRouter(T.cancellationReasonDefinition));
export default router;
