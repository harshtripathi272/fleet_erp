import { ApiResponse } from '../../core/response/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as CompanyService from './company.service.js';

export const getCompany = asyncHandler(async (_req, res) => {
  ApiResponse.success(res, await CompanyService.getCompany());
});
export const saveCompany = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await CompanyService.saveCompany(req.body, req.auth?.userId, req.requestId), 'Company details saved');
});
