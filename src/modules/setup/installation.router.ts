import { type RequestHandler, Router } from 'express';
import { z } from 'zod';
import { ForbiddenError } from '../../core/errors/index.js';
import { ApiResponse } from '../../core/response/index.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { productName } from '../company/brand.service.js';
import * as Setup from './setup.service.js';

/**
 * This installation (#95, platform design phase 1 and 3): what kind of copy this is, its configuration as a
 * file, a preview of what a configuration file would change, and a reset for a demonstration copy. Setting up
 * another company is not done from a company's copy.
 */
const router = Router();

const ownerOnly: RequestHandler = (req, _res, next) => {
  if (!req.auth?.roles.includes('owner')) throw new ForbiddenError('Only an owner can do this');
  next();
};

/** Public facts, for the sign-in page and for whoever deployed the copy: no names, e-mails or settings. */
router.get('/about', asyncHandler(async (_req, res) => {
  ApiResponse.success(res, { product: await productName(), ...Setup.installationFacts() });
}));

router.use(authenticate);
router.get('/status', authorize('company', 'read'), asyncHandler(async (_req, res) => ApiResponse.success(res, await Setup.setupStatus())));
/** The company's configuration as a company file, without passwords or keys (they are never stored). */
router.get('/export', authorize('company', 'update'), ownerOnly, asyncHandler(async (_req, res) => ApiResponse.success(res, await Setup.fromInstallation())));
router.post('/apply/preview', authorize('company', 'update'), ownerOnly, validate({ body: z.strictObject({ file: z.unknown() }) }), asyncHandler(async (req, res) => {
  ApiResponse.success(res, await Setup.previewApply(req.body as { file: unknown }));
}));
router.post('/reset', authorize('company', 'update'), ownerOnly, validate({ body: z.strictObject({ confirm: z.string().max(200).optional() }) }), asyncHandler(async (req, res) => {
  ApiResponse.success(res, await Setup.resetDemo((req.body as { confirm?: string }).confirm, { userId: req.auth!.userId }));
}));

export default router;
