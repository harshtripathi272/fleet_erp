import { Router } from 'express';
import { createMasterRouter } from '../../core/masters/router.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import * as FinanceController from './finance.controller.js';
import { convertMoneyQuerySchema } from './finance.schema.js';
import * as F from './finance.service.js';

const router = Router();
router.use('/currencies', createMasterRouter(F.currencyDefinition));
router.use('/exchange-rates', createMasterRouter(F.exchangeRateDefinition, (r) => {
  r.get('/convert', authorize('exchange-rates', 'read'), validate({ query: convertMoneyQuerySchema }), FinanceController.convertMoney);
}));
router.use('/payment-methods', createMasterRouter(F.paymentMethodDefinition));
export default router;
