import { ApiResponse } from '../../core/response/index.js';
import { ServiceUnavailableError } from '../../core/errors/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as HealthService from './health.service.js';

export const getHealth = asyncHandler(async (_req, res) => {
  ApiResponse.success(res, await HealthService.getHealth());
});

export const getReadiness = asyncHandler(async (_req, res) => {
  const readiness = await HealthService.getReadiness();
  if (!readiness.ready) throw new ServiceUnavailableError('Database is not connected', readiness);
  ApiResponse.success(res, readiness);
});
