import express, { type Request, Router } from 'express';
import { createMasterRouter } from '../../core/masters/router.js';
import type { Plain } from '../../core/masters/types.js';
import { idParams } from '../../core/masters/zod.js';
import { ApiResponse } from '../../core/response/index.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { z } from 'zod';
import { KINDS, SECRET_TARGETS, type Kind, type SecretTarget } from '../../core/connections/index.js';
import {
  answerHandshake, connectionDefinition, guardConnectionChange, kindsStatus, receiveInbound, secretSetupFor, testConnection, testConnectionSchema, testDraft, testDraftSchema,
  type TestDraftInput,
} from './connections.service.js';

const id = (req: Request) => (req.params as { id: string }).id;

/** Masters → Connections. Mounted at /api/v1 behind sign-in. */
const router = Router();
router.use('/connections', asyncHandler(async (req, _res, next) => {
  await guardConnectionChange(req.method, req.path, req.body as Plain | undefined, req.auth?.userId);
  next();
}), createMasterRouter(connectionDefinition, (r) => {
  // Before saving (#98): the values on the form, tested as they are.
  r.post('/test-draft', authorize('connections', 'create'), validate({ body: testDraftSchema }), asyncHandler(async (req, res) => {
    ApiResponse.success(res, await testDraft(req.body as TestDraftInput));
  }));
  r.post('/:id/test', authorize('connections', 'update'), validate({ params: idParams, body: testConnectionSchema }), asyncHandler(async (req, res) => {
    ApiResponse.success(res, await testConnection(id(req), req.body as { to?: string }, req.auth?.userId));
  }));
}));
router.get('/connection-kinds', authorize('connections', 'read'), asyncHandler(async (_req, res) => ApiResponse.success(res, await kindsStatus())));
/** Where to set a connection's secrets on a platform, and the commands (#98): a saved connection, or a provider being set up. */
const setupQuery = z.strictObject({
  target: z.enum(SECRET_TARGETS).default('env'),
  connectionId: z.string().regex(/^[0-9a-f]{24}$/i).optional(),
  kind: z.enum(KINDS).optional(),
  provider: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/).optional(),
  code: z.string().trim().min(1).max(32).optional(),
});
router.get('/connection-secret-setup', authorize('connections', 'read'), validate({ query: setupQuery }), asyncHandler(async (req, res) => {
  const q = req.query as unknown as { target: SecretTarget; connectionId?: string; kind?: Kind; provider?: string; code?: string };
  ApiResponse.success(res, await secretSetupFor(q));
}));
export default router;

/**
 * Calls from outside services (trackers, message replies): one URL per connection, no sign-in, signed
 * with the connection's secret. Mounted at /api/v1/hooks before the JSON parser, so the signature is
 * checked over the exact bytes that were sent.
 */
export const hooksRouter = Router();
hooksRouter.post('/:id', express.raw({ type: () => true, limit: '1mb' }), asyncHandler(async (req, res) => {
  const all = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v]));
  const result = await receiveInbound(id(req), { timestamp: req.get('x-signature-timestamp'), signature: req.get('x-signature'), all, contentType: req.get('content-type') }, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
  ApiResponse.success(res, result);
}));
/** A service checking the address before it sends (Meta): it expects its challenge back, as plain text. */
hooksRouter.get('/:id', asyncHandler(async (req, res) => {
  const query = Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, typeof v === 'string' ? v : undefined]));
  res.type('text/plain').send(await answerHandshake(id(req), query));
}));
