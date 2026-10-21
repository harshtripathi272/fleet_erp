import type { Request } from 'express';
import { contextOf } from '../../core/masters/controller.js';
import type { ListQuery } from '../../core/masters/service.js';
import type { Plain } from '../../core/masters/types.js';
import { ApiResponse, buildPaginationMeta } from '../../core/response/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as ConfigurationService from './configuration.service.js';

const params = (req: Request) => req.params as { masterId: string; id: string };
const ctx = (req: Request) => contextOf(req, 'custom-records');

export const listValues = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await ConfigurationService.listValues((req.params as { code: string }).code));
});
export const listRecords = asyncHandler(async (req, res) => {
  const result = await ConfigurationService.listRecords(params(req).masterId, req.query as unknown as ListQuery, ctx(req));
  ApiResponse.paginated(res, result.data, buildPaginationMeta(result.total, result.page, result.limit));
});
export const getRecord = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await ConfigurationService.getRecord(params(req).masterId, params(req).id, ctx(req)));
});
export const createRecord = asyncHandler(async (req, res) => {
  ApiResponse.created(res, await ConfigurationService.createRecord(params(req).masterId, req.body as Plain, ctx(req)), 'Record created');
});
export const updateRecord = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await ConfigurationService.updateRecord(params(req).masterId, params(req).id, req.body as Plain, ctx(req)), 'Record updated');
});
export const archiveRecord = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await ConfigurationService.archiveRecord(params(req).masterId, params(req).id, (req.body as { reason?: string }).reason, ctx(req)), 'Record archived');
});
export const restoreRecord = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await ConfigurationService.restoreRecord(params(req).masterId, params(req).id, ctx(req)), 'Record restored');
});
export const removeRecord = asyncHandler(async (req, res) => {
  await ConfigurationService.removeRecord(params(req).masterId, params(req).id, ctx(req));
  ApiResponse.noContent(res);
});
