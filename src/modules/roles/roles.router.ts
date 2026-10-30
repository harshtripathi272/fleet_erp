import { authorize } from '../../middleware/authorize.js';
import { createMasterRouter } from '../../core/masters/router.js';
import { getResources } from './roles.controller.js';
import { roleDefinition } from './roles.service.js';

export default createMasterRouter(roleDefinition, (router) => {
  router.get('/resources', authorize('roles', 'read'), getResources);
});
