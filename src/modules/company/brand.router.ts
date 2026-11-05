import { Router } from 'express';
import { z } from 'zod';
import { ApiResponse } from '../../core/response/index.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { brandAsset, publicBrand, type BrandAsset } from './brand.service.js';

/** The company's brand, before and after sign-in (#71): its name, colours and the logo files it chose. */
const router = Router();
router.get('/', asyncHandler(async (_req, res) => ApiResponse.success(res, await publicBrand())));
router.get('/:asset', validate({ params: z.strictObject({ asset: z.enum(['logo', 'logo-dark', 'icon', 'logo-pdf']) }) }), asyncHandler(async (req, res) => {
  const { mime, stream } = await brandAsset(req.params.asset as BrandAsset);
  res.setHeader('Content-Type', mime);
  // The URL carries the file id (?v=…), so a new logo is a new URL and the old one may be cached for long.
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  stream.pipe(res);
}));
export default router;
