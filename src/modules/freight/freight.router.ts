import { Router } from 'express';
import { createMasterRouter } from '../../core/masters/router.js';
import { idParams } from '../../core/masters/zod.js';
import { ApiResponse } from '../../core/response/index.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { requireModule } from '../operations/settings.js';
import { opsContext } from '../operations/support.js';
import * as A from './freight.api.js';
import * as F from './freight.masters.js';
import * as P from './pricing.js';

/** The freight masters and routes (#135). Mounted at /api/v1 behind sign-in, in the Trips area like the masters. */
const router = Router();
const id = { params: idParams };
const param = (req: { params: unknown }, key = 'id') => (req.params as Record<string, string>)[key]!;

router.post('/tariffs/try', requireModule('trips'), authorize('tariffs', 'read'), validate({ body: A.tryTariffSchema }), asyncHandler(async (req, res) => ApiResponse.success(res, await A.tryTariff(req.body, undefined, opsContext(req)))));
router.post('/tariffs/:id/try', requireModule('trips'), authorize('tariffs', 'read'), validate({ ...id, body: A.tryTariffSchema }), asyncHandler(async (req, res) => ApiResponse.success(res, await A.tryTariff(req.body, param(req), opsContext(req)))));
router.get('/tariffs/:id/match', requireModule('trips'), authorize('tariffs', 'read'), validate({ ...id, query: A.matchQuery }), asyncHandler(async (req, res) => ApiResponse.success(res, await A.matchFor(param(req), String((req.query as Record<string, string>).consignmentId)))));
router.get('/freight/formula/variables', asyncHandler(async (_req, res) => ApiResponse.success(res, A.formulaReference())));

router.use('/consignment-types', createMasterRouter(F.consignmentTypeDefinition));
router.use('/consignment-document-types', createMasterRouter(F.consignmentDocumentTypeDefinition));
router.use('/charge-types', createMasterRouter(F.chargeTypeDefinition));
router.use('/tariffs', createMasterRouter(F.tariffDefinition));
router.use('/fuel-prices', createMasterRouter(F.fuelPriceDefinition));

/* A consignment's revenue (design 3.5.8, 3.11.7). Seeing it is the area's sensitive switch. */
const sees = authorize('consignment-revenue', 'sensitive');
router.get('/consignments/:id/revenue', requireModule('trips'), sees, validate(id), asyncHandler(async (req, res) => ApiResponse.success(res, await P.getRevenue(param(req)))));
router.post('/consignments/:id/reprice', requireModule('trips'), sees, authorize('consignment-revenue', 'update'), validate({ ...id, query: A.previewQuery }), asyncHandler(async (req, res) => {
  const preview = ['1', 'true'].includes(String((req.query as Record<string, string>).preview ?? ''));
  const result = await P.reprice(param(req), opsContext(req), { preview });
  return ApiResponse.success(res, (preview ? result : await P.getRevenue(param(req))) ?? {}, preview ? undefined : 'Repriced');
}));
router.post('/consignments/:id/revenue/lines', requireModule('trips'), sees, validate({ ...id, body: A.chargeLineSchema }), asyncHandler(async (req, res) => ApiResponse.created(res, await P.addChargeLine(param(req), req.body, opsContext(req)), 'Charge added')));
router.patch('/consignments/:id/revenue/lines/:lineId', requireModule('trips'), sees, validate({ params: A.lineParams, body: A.acceptLineSchema }), asyncHandler(async (req, res) => ApiResponse.success(res, await P.setLineAccepted(param(req), param(req, 'lineId'), req.body.accepted, opsContext(req)))));
router.post('/consignments/:id/revenue/manual', requireModule('trips'), sees, validate({ ...id, body: A.manualPriceSchema }), asyncHandler(async (req, res) => ApiResponse.success(res, await P.setManualPrice(param(req), req.body, opsContext(req)), 'Price set')));
router.post('/consignments/:id/revenue/freeze', requireModule('trips'), sees, validate(id), asyncHandler(async (req, res) => ApiResponse.success(res, await P.freeze(param(req), opsContext(req)), 'Frozen')));
router.post('/consignments/:id/revenue/reopen', requireModule('trips'), sees, validate({ ...id, body: A.reasonBody }), asyncHandler(async (req, res) => ApiResponse.success(res, await P.reopen(param(req), req.body.reason, opsContext(req)), 'Reopened')));
export default router;
