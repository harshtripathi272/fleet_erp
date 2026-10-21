import { ApiResponse } from '../../core/response/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { ACTIONS } from '../../core/masters/types.js';
import * as RolesService from './roles.service.js';

export const getResources = asyncHandler(async (_req, res) => {
  ApiResponse.success(res, { resources: RolesService.knownResources(), actions: ['*', ...ACTIONS] });
});
