import { Router } from 'express';
import { createMasterRouter } from '../../core/masters/router.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import * as FinanceController from './finance.controller.js';
import { convertMoneyQuerySchema, rateFeedSettingsSchema } from './finance.schema.js';
import * as F from './finance.service.js';
import billingRouter from './billing/billing.router.js';
import { financeSettingsSchema } from './billing/billing.schema.js';
import { getSettings, saveSettings } from './settings.service.js';
import { ApiResponse } from '../../core/response/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

const router = Router();
router.use('/currencies', createMasterRouter(F.currencyDefinition));
router.use('/exchange-rates', createMasterRouter(F.exchangeRateDefinition, (r) => {
  r.get('/convert', authorize('exchange-rates', 'read'), validate({ query: convertMoneyQuerySchema }), FinanceController.convertMoney);
  // The daily feed: its setting, the last runs, and "Fetch now".
  r.get('/feed', authorize('exchange-rates', 'read'), FinanceController.rateFeed);
  r.put('/feed', authorize('exchange-rates', 'update'), validate({ body: rateFeedSettingsSchema }), FinanceController.saveRateFeed);
  r.post('/feed/run', authorize('exchange-rates', 'create'), FinanceController.runRateFeed);
}));
router.use('/payment-methods', createMasterRouter(F.paymentMethodDefinition));
// Company → Money: which rate conversions use, the pivot currency, and the billing rules (#61).
router.get('/finance-settings', authorize('finance-settings', 'read'), asyncHandler(async (_req, res) => ApiResponse.success(res, await getSettings())));
router.put('/finance-settings', authorize('finance-settings', 'update'), validate({ body: financeSettingsSchema }), asyncHandler(async (req, res) => {
  ApiResponse.success(res, await saveSettings(req.body, req.auth?.userId, req.requestId), 'Money settings saved');
}));
router.use(billingRouter);
export default router;
