import { ApiResponse } from '../../core/response/index.js';
import { contextOf } from '../../core/masters/controller.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as FleetService from './fleet.service.js';

export const pair = asyncHandler(async (req, res) => {
  ApiResponse.created(res, await FleetService.pair(req.body, contextOf(req, 'pairings')), 'Truck and trailer paired');
});
export const endPairing = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await FleetService.endPairing((req.params as { id: string }).id, req.body, contextOf(req, 'pairings')), 'Pairing ended');
});
