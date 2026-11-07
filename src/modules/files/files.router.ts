import express, { Router } from 'express';
import { env } from '../../config/env.js';
import { idParams } from '../../core/masters/zod.js';
import { rateLimit } from '../../core/rateLimit/index.js';
import { idempotent } from '../../middleware/idempotency.js';
import { validate } from '../../middleware/validate.js';
import { z } from 'zod';
import * as C from './files.controller.js';

/** Uploaded documents. Mounted at /api/v1/files behind `authenticate`; the service checks who may do what. */
const router = Router();

// Per person, so one account (or a stolen driver phone) cannot fill the storage. A trip needs a handful.
const uploadLimit = rateLimit({ name: 'upload', limit: 60, windowMs: 10 * 60000, key: (req) => req.auth?.userId ?? 'anonymous' });

// A phone that lost its signal sends the same upload again with the same Idempotency-Key: one file is kept.
// The field a file is for (#97), when it is for a company's file field: its kinds and size apply.
const uploadQuery = z.strictObject({
  entity: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/).optional(),
  master: z.string().regex(/^[0-9a-f]{24}$/).optional(),
  field: z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/).optional(),
}).refine((q) => !q.field === !(q.entity || q.master), 'Name the field with its master');
router.post('/', uploadLimit, validate({ query: uploadQuery }), idempotent, express.raw({ type: () => true, limit: `${env.UPLOAD_MAX_MB}mb` }), C.upload);
router.get('/:id', validate({ params: idParams }), C.download);

export default router;
