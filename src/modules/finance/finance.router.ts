import { Router } from 'express';
import { createMasterRouter } from '../../core/masters/router.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import * as FinanceController from './finance.controller.js';
import { convertMoneyQuerySchema, rateFeedSettingsSchema } from './finance.schema.js';
import * as F from './finance.service.js';

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
export default router;
