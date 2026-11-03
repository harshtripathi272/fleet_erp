import express, { Router } from 'express';
import { env } from '../../config/env.js';
import { idParams } from '../../core/masters/zod.js';
import { rateLimit } from '../../core/rateLimit/index.js';
import { idempotent } from '../../middleware/idempotency.js';
import { validate } from '../../middleware/validate.js';
import * as C from './files.controller.js';

/** Uploaded documents. Mounted at /api/v1/files behind `authenticate`; the service checks who may do what. */
const router = Router();

// Per person, so one account (or a stolen driver phone) cannot fill the storage. A trip needs a handful.
const uploadLimit = rateLimit({ name: 'upload', limit: 60, windowMs: 10 * 60000, key: (req) => req.auth?.userId ?? 'anonymous' });

// A phone that lost its signal sends the same upload again with the same Idempotency-Key: one file is kept.
router.post('/', uploadLimit, idempotent, express.raw({ type: () => true, limit: `${env.UPLOAD_MAX_MB}mb` }), C.upload);
router.get('/:id', validate({ params: idParams }), C.download);

export default router;
