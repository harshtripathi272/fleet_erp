import { createMasterRouter } from '../../core/masters/router.js';
import { idParams } from '../../core/masters/zod.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import * as UsersController from './users.controller.js';
import { createUserSchema, driverAccessParams, driverAccessSchema } from './users.schema.js';
import { userDefinition } from './users.service.js';

export default createMasterRouter(userDefinition, (router) => {
  // A driver's sign-in for the driver app, managed from the driver's record.
  router.get('/driver-access/:driverId', authorize('users', 'read'), validate({ params: driverAccessParams }), UsersController.getDriverAccess);
  router.put('/driver-access/:driverId', authorize('users', 'update'), validate({ params: driverAccessParams, body: driverAccessSchema }), UsersController.setDriverAccess);
  router.delete('/driver-access/:driverId', authorize('users', 'update'), validate({ params: driverAccessParams }), UsersController.removeDriverAccess);
  router.post('/', authorize('users', 'create'), validate({ body: createUserSchema }), UsersController.createUser);
  router.post('/:id/revoke-sessions', authorize('users', 'update'), validate({ params: idParams }), UsersController.revokeUserSessions);
  router.post('/:id/unlock', authorize('users', 'update'), validate({ params: idParams }), UsersController.unlockUser);
});
