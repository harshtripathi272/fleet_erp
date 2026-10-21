import { ApiResponse } from '../../core/response/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import type { EstimateQuery } from './trips.schema.js';
import * as TripsService from './trips.service.js';

export const estimate = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await TripsService.estimate(req.query as unknown as EstimateQuery));
});
