import { Router } from 'express';
import { z } from 'zod';
import { idParams, objectId } from '../../core/masters/zod.js';
import { ApiResponse } from '../../core/response/index.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { listUnmatched, matchUnmatched } from './positions.service.js';

/** Masters → Connections, the fleet data exchange's parts (#136). Mounted at /api/v1 behind sign-in. */
const router = Router();
const id = (req: { params: unknown }) => (req.params as { id: string }).id;

router.get('/fleet-exchange/unmatched', authorize('connections', 'read'), validate({ query: z.strictObject({ connectionId: objectId.optional() }) }), asyncHandler(async (req, res) => {
  ApiResponse.success(res, await listUnmatched((req.query as { connectionId?: string }).connectionId));
}));
router.post('/fleet-exchange/unmatched/:id/match', authorize('connections', 'update'), validate({ params: idParams, body: z.strictObject({ vehicleId: objectId }) }), asyncHandler(async (req, res) => {
  ApiResponse.success(res, await matchUnmatched(id(req), (req.body as { vehicleId: string }).vehicleId));
}));

export default router;
