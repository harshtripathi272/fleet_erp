import { Router } from 'express';
import { createMasterRouter } from '../../core/masters/router.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import * as GeographyController from './geography.controller.js';
import { convertQuerySchema, nearQuerySchema } from './geography.schema.js';
import * as G from './geography.service.js';

const router = Router();
router.use('/countries', createMasterRouter(G.countryDefinition));
router.use('/provinces', createMasterRouter(G.provinceDefinition));
router.use('/cities', createMasterRouter(G.cityDefinition));
router.use('/places', createMasterRouter(G.placeDefinition, (r) => {
  r.get('/near', authorize('places', 'read'), validate({ query: nearQuerySchema }), GeographyController.placesNear);
}));
router.use('/border-posts', createMasterRouter(G.borderPostDefinition));
router.use('/routes', createMasterRouter(G.routeDefinition));
router.use('/units', createMasterRouter(G.unitDefinition));
router.use('/unit-conversions', createMasterRouter(G.unitConversionDefinition, (r) => {
  r.get('/convert', authorize('unit-conversions', 'read'), validate({ query: convertQuerySchema }), GeographyController.convertUnits);
}));
export default router;
