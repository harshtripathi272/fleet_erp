import { ApiResponse } from '../../core/response/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import type { ConvertMoneyQuery } from './finance.schema.js';
import * as FinanceService from './finance.service.js';

export const convertMoney = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await FinanceService.convertMoney(req.query as unknown as ConvertMoneyQuery));
});
