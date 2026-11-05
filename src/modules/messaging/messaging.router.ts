import { Router } from 'express';
import { createMasterRouter } from '../../core/masters/router.js';
import { idParams } from '../../core/masters/zod.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import * as MessagingController from './messaging.controller.js';
import { outboxQuerySchema, previewSchema } from './messaging.schema.js';
import * as M from './messaging.service.js';

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

export default router;
