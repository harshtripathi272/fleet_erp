import { ApiResponse } from '../../core/response/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import type { ConvertQuery, NearQuery } from './geography.schema.js';
import * as GeographyService from './geography.service.js';
import * as PlaceSearch from './placeSearch.js';

export const placesNear = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await GeographyService.placesNear(req.query as unknown as NearQuery));
});
export const findPlaces = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await PlaceSearch.findPlaces(req.query as unknown as PlaceSearch.FindQuery));
});
export const cityFor = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await PlaceSearch.cityFor(req.body, { actorId: req.auth?.userId }));
});
export const convertUnits = asyncHandler(async (req, res) => {
  ApiResponse.success(res, await GeographyService.convertUnits(req.query as unknown as ConvertQuery));
});
