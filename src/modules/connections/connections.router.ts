import express, { type Request, Router } from 'express';
import { createMasterRouter } from '../../core/masters/router.js';
import { idParams } from '../../core/masters/zod.js';
import { ApiResponse } from '../../core/response/index.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { connectionDefinition, kindsStatus, receiveInbound, testConnection, testConnectionSchema } from './connections.service.js';

const id = (req: Request) => (req.params as { id: string }).id;

/** Masters → Connections. Mounted at /api/v1 behind sign-in. */
const router = Router();
router.use('/connections', createMasterRouter(connectionDefinition, (r) => {
  r.post('/:id/test', authorize('connections', 'update'), validate({ params: idParams, body: testConnectionSchema }), asyncHandler(async (req, res) => {
    ApiResponse.success(res, await testConnection(id(req), req.body as { to?: string }, req.auth?.userId));
  }));
}));
router.get('/connection-kinds', authorize('connections', 'read'), asyncHandler(async (_req, res) => ApiResponse.success(res, await kindsStatus())));
export default router;

/**
 * Calls from outside services (trackers, message replies): one URL per connection, no sign-in, signed
 * with the connection's secret. Mounted at /api/v1/hooks before the JSON parser, so the signature is
 * checked over the exact bytes that were sent.
 */
export const hooksRouter = Router();
hooksRouter.post('/:id', express.raw({ type: () => true, limit: '1mb' }), asyncHandler(async (req, res) => {
  const result = await receiveInbound(id(req), { timestamp: req.get('x-signature-timestamp'), signature: req.get('x-signature') }, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
  ApiResponse.success(res, result);
}));
