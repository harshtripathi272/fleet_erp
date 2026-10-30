import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { clientIp, rateLimit } from '../../core/rateLimit/index.js';
import * as AuthController from './auth.controller.js';
import {
  changePasswordSchema, forgotPasswordSchema, loginSchema, refreshSchema, registerSchema, resetPasswordSchema, updateMeSchema,
} from './auth.schema.js';
import { z } from 'zod';

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const emailKey = (req: { body?: { email?: unknown } }) => String(req.body?.email ?? '').trim().toLowerCase().slice(0, 254);
const empty = z.strictObject({});

const router = Router();
router.post('/register', rateLimit({ name: 'register', limit: 10, windowMs: HOUR }), validate({ body: registerSchema }), AuthController.register);
router.post('/login',
  rateLimit({ name: 'login-ip', limit: 30, windowMs: MINUTE }),
  rateLimit({ name: 'login-account', limit: 10, windowMs: 15 * MINUTE, key: (req) => `${clientIp(req)}:${emailKey(req)}` }),
  validate({ body: loginSchema }), AuthController.login);
router.post('/refresh', rateLimit({ name: 'refresh', limit: 60, windowMs: MINUTE }), validate({ body: refreshSchema }), AuthController.refresh);
router.post('/forgot-password',
  rateLimit({ name: 'forgot-ip', limit: 20, windowMs: HOUR }),
  rateLimit({ name: 'forgot-account', limit: 5, windowMs: HOUR, key: emailKey }),
  validate({ body: forgotPasswordSchema }), AuthController.forgotPassword);
router.post('/reset-password', rateLimit({ name: 'reset', limit: 20, windowMs: HOUR }), validate({ body: resetPasswordSchema }), AuthController.resetPassword);

router.get('/me', authenticate, AuthController.me);
router.patch('/me', authenticate, validate({ body: updateMeSchema }), AuthController.updateMe);
router.get('/sessions', authenticate, AuthController.sessions);
router.post('/change-password', authenticate, rateLimit({ name: 'change-password', limit: 10, windowMs: HOUR }), validate({ body: changePasswordSchema }), AuthController.changePassword);
router.post('/logout', authenticate, validate({ body: empty.optional() }), AuthController.logout);
router.post('/logout-all', authenticate, validate({ body: empty.optional() }), AuthController.logoutAll);

export default router;
