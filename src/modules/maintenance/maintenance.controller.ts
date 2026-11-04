import { ApiResponse } from '../../core/response/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as M from './maintenance.service.js';

export const services = asyncHandler(async (_req, res) => ApiResponse.success(res, await M.serviceStatus()));
export const held = asyncHandler(async (_req, res) => ApiResponse.success(res, await M.heldTrucks()));
export const costs = asyncHandler(async (req, res) => ApiResponse.success(res, await M.costs(req.query as never)));
