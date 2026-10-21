import { ApiResponse, buildPaginationMeta } from '../../core/response/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import type { AuditQuery } from './audit.schema.js';
import * as AuditService from './audit.service.js';

export const listAuditLogs = asyncHandler(async (req, res) => {
  const result = await AuditService.listAuditLogs(req.query as unknown as AuditQuery);
  ApiResponse.paginated(res, result.data, buildPaginationMeta(result.total, result.page, result.limit));
});
