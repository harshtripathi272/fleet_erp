import express, { Router } from 'express';
import { env } from '../../config/env.js';
import { idParams } from '../../core/masters/zod.js';
import { validate } from '../../middleware/validate.js';
import * as C from './files.controller.js';

/** Uploaded documents. Mounted at /api/v1/files behind `authenticate`; the service checks who may do what. */
const router = Router();

router.post('/', express.raw({ type: () => true, limit: `${env.UPLOAD_MAX_MB}mb` }), C.upload);
router.get('/:id', validate({ params: idParams }), C.download);

export default router;
