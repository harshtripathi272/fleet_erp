import { Router } from 'express';
import { createMasterRouter } from '../../core/masters/router.js';
import { idParams } from '../../core/masters/zod.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import * as MessagingController from './messaging.controller.js';
import { env } from '../../config/env.js';
import { connectionDefinition, testConnectionSchema } from './connections.service.js';
import { startOutboxWorker } from './dispatcher.js';
import { outboxQuerySchema, previewSchema } from './messaging.schema.js';
import * as M from './messaging.service.js';

const router = Router();
router.use('/message-templates', createMasterRouter(M.messageTemplateDefinition, (r) => {
  r.post('/:id/preview', authorize('message-templates', 'read'), validate({ params: idParams, body: previewSchema }), MessagingController.previewTemplate);
}));
router.use('/notification-rules', createMasterRouter(M.notificationRuleDefinition));
router.use('/print-layouts', createMasterRouter(M.printLayoutDefinition));

// How each channel sends, and every message sent. The outbox is read and resent by whoever may manage connections.
router.use('/message-connections', createMasterRouter(connectionDefinition, (r) => {
  r.post('/:id/test', authorize('message-connections', 'update'), validate({ params: idParams, body: testConnectionSchema }), MessagingController.testConnection);
}));
router.get('/message-channels', authorize('message-connections', 'read'), MessagingController.channels);
router.get('/message-outbox', authorize('message-connections', 'read'), validate({ query: outboxQuerySchema }), MessagingController.outbox);
router.get('/message-outbox/:id', authorize('message-connections', 'read'), validate({ params: idParams }), MessagingController.outboxMessage);
router.post('/message-outbox/:id/resend', authorize('message-connections', 'update'), validate({ params: idParams }), MessagingController.resend);

// Retries and delayed messages go out from here. Off in tests, which call processDue themselves.
if (env.NODE_ENV !== 'test') startOutboxWorker();

export default router;
