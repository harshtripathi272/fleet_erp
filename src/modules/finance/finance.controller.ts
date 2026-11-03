import { ApiResponse } from '../../core/response/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import type { ConvertMoneyQuery } from './finance.schema.js';
import * as FinanceService from './finance.service.js';
import * as RateFeed from './rateFeed.service.js';

export const convertMoney = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await FinanceService.convertMoney(req.query as unknown as ConvertMoneyQuery));
});

export const rateFeed = asyncHandler(async (_req, res) => ApiResponse.success(res, await RateFeed.feedStatus()));
export const saveRateFeed = asyncHandler(async (req, res) => ApiResponse.success(res, await RateFeed.saveFeedSettings(req.body, req.auth?.userId), 'Rate feed saved'));
export const runRateFeed = asyncHandler(async (req, res) => {
  const run = await RateFeed.fetchRates({ trigger: 'manual', actorId: req.auth?.userId });
  ApiResponse.success(res, run, run.outcome === 'stored' ? `Stored ${run.stored} rate${run.stored === 1 ? '' : 's'}` : run.outcome === 'off' ? 'The rate feed is off (manual rates)' : `Fetch failed: ${run.error}`);
});
