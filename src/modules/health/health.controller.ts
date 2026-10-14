import { ApiResponse } from '../../core/response/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as HealthService from './health.service.js';

export const getHealth = asyncHandler(async (_req, res) => {
  ApiResponse.success(res, await HealthService.getHealth());
});
