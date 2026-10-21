import { ApiResponse } from '../../core/response/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as OrganisationService from './organisation.service.js';

export const previewSeries = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await OrganisationService.previewSeries((req.params as { id: string }).id));
});
export const reserveSeries = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await OrganisationService.reserveSeries((req.params as { id: string }).id, req.auth?.userId, req.requestId), 'Number issued');
});
export const seriesEntities = asyncHandler(async (_req, res) => {
  ApiResponse.success(res, OrganisationService.seriesEntities());
});
