import { Router } from 'express';
import { createMasterRouter } from '../../core/masters/router.js';
import { idParams } from '../../core/masters/zod.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import * as FleetController from './fleet.controller.js';
import { endPairingSchema, pairSchema } from './fleet.schema.js';
import * as F from './fleet.service.js';

const router = Router();
router.use('/vehicle-makes', createMasterRouter(F.vehicleMakeDefinition));
router.use('/vehicle-models', createMasterRouter(F.vehicleModelDefinition));
router.use('/vehicle-types', createMasterRouter(F.vehicleTypeDefinition));
router.use('/vehicles', createMasterRouter(F.vehicleDefinition));
router.use('/trailer-types', createMasterRouter(F.trailerTypeDefinition));
router.use('/trailers', createMasterRouter(F.trailerDefinition));
router.use('/pairings', createMasterRouter(F.pairingDefinition, (r) => {
  r.post('/', authorize('pairings', 'create'), validate({ body: pairSchema }), FleetController.pair);
  r.post('/:id/end', authorize('pairings', 'update'), validate({ params: idParams, body: endPairingSchema }), FleetController.endPairing);
}));
export default router;
