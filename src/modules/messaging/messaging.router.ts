import { Router } from 'express';
import { createMasterRouter } from '../../core/masters/router.js';
import { idParams } from '../../core/masters/zod.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import * as MessagingController from './messaging.controller.js';
import { previewSchema } from './messaging.schema.js';
import * as M from './messaging.service.js';

const router = Router();
router.use('/message-templates', createMasterRouter(M.messageTemplateDefinition, (r) => {
  r.post('/:id/preview', authorize('message-templates', 'read'), validate({ params: idParams, body: previewSchema }), MessagingController.previewTemplate);
}));
router.use('/notification-rules', createMasterRouter(M.notificationRuleDefinition));
router.use('/print-layouts', createMasterRouter(M.printLayoutDefinition));
export default router;
