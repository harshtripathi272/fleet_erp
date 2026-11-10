import { Router } from 'express';
import { createMasterRouter } from '../../core/masters/router.js';
import * as F from './freight.masters.js';

/** The freight masters (#135). Mounted at /api/v1 behind sign-in, like every other master. */
const router = Router();
router.use('/consignment-types', createMasterRouter(F.consignmentTypeDefinition));
router.use('/consignment-document-types', createMasterRouter(F.consignmentDocumentTypeDefinition));
router.use('/charge-types', createMasterRouter(F.chargeTypeDefinition));
router.use('/tariffs', createMasterRouter(F.tariffDefinition));
router.use('/fuel-prices', createMasterRouter(F.fuelPriceDefinition));
export default router;
