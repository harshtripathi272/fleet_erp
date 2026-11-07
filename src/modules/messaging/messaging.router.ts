import { Router } from 'express';
import { createMasterRouter } from '../../core/masters/router.js';
import { idParams } from '../../core/masters/zod.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import * as MessagingController from './messaging.controller.js';
import { outboxQuerySchema, previewSchema } from './messaging.schema.js';
import * as M from './messaging.service.js';
import { z } from 'zod';
import { ApiResponse } from '../../core/response/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { productName } from '../company/brand.service.js';
import * as WhatsApp from './whatsapp/service.js';

const router = Router();
router.use('/message-templates', createMasterRouter(M.messageTemplateDefinition, (r) => {
  r.post('/:id/preview', authorize('message-templates', 'read'), validate({ params: idParams, body: previewSchema }), MessagingController.previewTemplate);
}));
router.use('/notification-rules', createMasterRouter(M.notificationRuleDefinition));
router.use('/print-layouts', createMasterRouter(M.printLayoutDefinition));

// How each channel sends, and every message sent. The outbox is read and resent by whoever may manage connections (#59).
router.get('/message-channels', authorize('connections', 'read'), MessagingController.channels);
router.get('/message-outbox', authorize('connections', 'read'), validate({ query: outboxQuerySchema }), MessagingController.outbox);
router.get('/message-outbox/:id', authorize('connections', 'read'), validate({ params: idParams }), MessagingController.outboxMessage);
router.post('/message-outbox/:id/resend', authorize('connections', 'update'), validate({ params: idParams }), MessagingController.resend);

// Every WhatsApp message as a Meta template (#112): what each says, where it stands, submit, and the pack to hand over.
router.get('/whatsapp-templates', authorize('connections', 'read'), asyncHandler(async (_req, res) => ApiResponse.success(res, await WhatsApp.listTemplates())));
router.post('/whatsapp-templates/submit', authorize('connections', 'update'), validate({ body: z.strictObject({ names: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,99}$/)).max(50).optional() }) }), asyncHandler(async (req, res) => {
  ApiResponse.success(res, { results: await WhatsApp.submitTemplates((req.body as { names?: string[] }).names), ...(await WhatsApp.listTemplates()) });
}));
router.post('/whatsapp-templates/refresh', authorize('connections', 'read'), asyncHandler(async (_req, res) => {
  ApiResponse.success(res, { ...(await WhatsApp.refreshTemplates()), ...(await WhatsApp.listTemplates()) });
}));
router.get('/whatsapp-templates/export.json', authorize('connections', 'read'), asyncHandler(async (_req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="whatsapp-templates.json"');
  res.json(WhatsApp.templatesJson());
}));
router.get('/whatsapp-templates/export.md', authorize('connections', 'read'), asyncHandler(async (_req, res) => {
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="whatsapp-templates.md"');
  res.send(WhatsApp.templatesDocument(await productName()));
}));

export default router;
