import { ApiResponse } from '../../core/response/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import type { CheckQuery, ExpiringQuery } from './compliance.schema.js';
import * as ComplianceService from './compliance.service.js';

export const expiring = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await ComplianceService.expiring(req.query as unknown as ExpiringQuery));
});
export const check = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await ComplianceService.check(req.query as unknown as CheckQuery));
});
