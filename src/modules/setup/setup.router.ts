import { Router } from 'express';
import { z } from 'zod';
import { ValidationError } from '../../core/errors/index.js';
import { ApiResponse } from '../../core/response/index.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as Setup from './setup.service.js';

/**
 * The Company kit (#76): this installation as a company file, a check of a file, and the kit itself.
 * For whoever may change the company. Mounted ahead of the shared JSON parser, with room for logos and
 * spreadsheets (sent base64 inside the JSON).
 */
const router = Router();
const body = z.strictObject({
  file: z.unknown(),
  // A list, not an object keyed by path: field names with dots are refused (rejectOperators).
  attachments: z.array(z.strictObject({ path: z.string().regex(/^(files|data)\/[A-Za-z0-9._-]{1,80}$/), data: z.string().max(14_000_000) })).max(80).default([]),
});

router.get('/', authorize('company', 'update'), asyncHandler(async (_req, res) => {
  ApiResponse.success(res, { ...(await Setup.fromInstallation()), ...(await Setup.kitOptions()) });
}));
router.post('/check', authorize('company', 'update'), validate({ body }), asyncHandler(async (req, res) => {
  ApiResponse.success(res, Setup.check(req.body as Setup.KitRequest));
}));
/** The zip when the file is good; otherwise 422 with each problem and where it is. */
router.post('/kit', authorize('company', 'update'), validate({ body }), asyncHandler(async (req, res) => {
  const result = Setup.kit(req.body as Setup.KitRequest);
  if (!result.zip) throw new ValidationError('The company file has problems', { problems: result.problems.map((p) => `${p.path}: ${p.message}`) });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${result.name}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(result.zip);
}));

export default router;
