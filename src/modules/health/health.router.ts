import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { getHealth } from './health.controller.js';
import { healthQuerySchema } from './health.schema.js';

const router = Router();
router.get('/', validate({ query: healthQuerySchema }), getHealth);
export default router;
