import type { Request } from 'express';
import { ApiResponse, buildPaginationMeta } from '../../core/response/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import type { AuditExportQuery, AuditQuery } from './audit.schema.js';
import * as AuditService from './audit.service.js';

const reader = (req: Request): AuditService.AuditReader => ({ can: req.auth!.can });

export const listAuditLogs = asyncHandler(async (req, res) => {
  const result = await AuditService.listAuditLogs(req.query as unknown as AuditQuery, reader(req));
  ApiResponse.paginated(res, result.data, buildPaginationMeta(result.total, result.page, result.limit));
});

export const auditPeople = asyncHandler(async (_req, res) => ApiResponse.success(res, await AuditService.auditPeople()));
export const auditEntities = asyncHandler(async (_req, res) => ApiResponse.success(res, await AuditService.auditEntities()));

/** The current filter as a CSV file (at most 10,000 entries). */
export const exportAuditLogs = asyncHandler(async (req, res) => {
  const csv = await AuditService.exportCsv(req.query as unknown as AuditExportQuery, reader(req));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  // A byte-order mark, so a spreadsheet reads names with accents correctly.
  res.send(`﻿${csv}`);
});
