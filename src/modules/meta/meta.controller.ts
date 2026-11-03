import { env } from '../../config/env.js';
import { NotFoundError } from '../../core/errors/index.js';
import { ApiResponse } from '../../core/response/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import auditRouter from '../audit/audit.router.js';
import authRouter from '../auth/auth.router.js';
import companyRouter from '../company/company.router.js';
import healthRouter from '../health/health.router.js';
import operationsRouter, { webhookRouter } from '../operations/operations.router.js';
import * as MetaService from './meta.service.js';
import { loadSampleData, type SampleSize } from './sampleData.js';

export const masters = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await MetaService.describeMasters(req.auth));
});

/** The same descriptions without the caller's permissions, for the public models reference. */
export const models = asyncHandler(async (_req, res) => {
  const list = await MetaService.describeMasters();
  ApiResponse.success(res, list.map((m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'permissions'))));
});

export const overview = asyncHandler(async (req, res) => {
  ApiResponse.success(res, {
    system: MetaService.system(),
    limits: MetaService.limits(),
    you: { userId: req.auth!.userId, name: req.auth!.name, email: req.auth!.email, roles: req.auth!.roles, permissions: req.auth!.permissions },
    endpoints: [
      ...MetaService.endpointsOf(healthRouter, '/api/v1/health', false),
      ...MetaService.endpointsOf(authRouter, '/api/v1/auth', false),
      ...MetaService.endpointsOf(companyRouter, '/api/v1/company', true),
      ...MetaService.endpointsOf(auditRouter, '/api/v1/audit-logs', true),
      ...MetaService.endpointsOf(operationsRouter, '/api/v1', true),
      ...MetaService.endpointsOf(webhookRouter, '/api/v1/whatsapp', false),
    ],
  });
});

export const stats = asyncHandler(async (_req, res) => {
  ApiResponse.success(res, await MetaService.stats());
});

/** Development aid: e-mails the API would have sent (only when EXPOSE_RESET_TOKEN=true). */
export const outbox = asyncHandler(async (_req, res) => {
  if (!env.EXPOSE_RESET_TOKEN || env.NODE_ENV === 'production') throw new NotFoundError('Route not found');
  ApiResponse.success(res, MetaService.outbox());
});

/** Loads the sample operation once (outside production). */
export const sampleData = asyncHandler(async (req, res) => {
  if (env.NODE_ENV === 'production') throw new NotFoundError('Route not found');
  ApiResponse.created(res, await loadSampleData(req.auth?.userId, (req.body as { size: SampleSize }).size), 'Sample data loaded');
});
