import { Router } from 'express';
import { ApiResponse } from '../../core/response/index.js';
import { authorize } from '../../middleware/authorize.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { Vehicle } from '../fleet/models/vehicle.model.js';
import { Trip } from '../operations/models/trip.model.js';
import { requireModule } from '../operations/settings.js';
import { VehiclePosition } from './positions.service.js';
import { roadShapes } from './routing.service.js';

/** For the maps (#60): the road shapes of open trips' legs, and each truck's latest tracker position. */
const router = Router();
const tracking = requireModule('tracking');

router.get('/tracking/road-legs', tracking, authorize('trips', 'read'), asyncHandler(async (_req, res) => {
  const trips = await Trip.find({ active: true }).select('stops.placeId').lean<Array<{ stops: Array<{ placeId: unknown }> }>>();
  const pairs = new Map<string, [string, string]>();
  for (const t of trips) for (let i = 1; i < t.stops.length; i++) {
    const pair: [string, string] = [String(t.stops[i - 1]!.placeId), String(t.stops[i]!.placeId)];
    if (pair[0] !== pair[1]) pairs.set(pair.join('-'), pair);
  }
  ApiResponse.success(res, await roadShapes([...pairs.values()]));
}));

router.get('/tracking/positions', tracking, authorize('trips', 'read'), asyncHandler(async (_req, res) => {
  const positions = await VehiclePosition.find().select('-inside').sort({ at: -1 }).limit(1000).lean();
  const plates = new Map((await Vehicle.find({ _id: { $in: positions.map((p) => p.vehicleId) } }).select('registrationNumber').lean()).map((v) => [String(v._id), v.registrationNumber]));
  ApiResponse.success(res, positions.map((p) => ({ vehicleId: String(p.vehicleId), plate: plates.get(String(p.vehicleId)), deviceId: p.deviceId, lat: p.lat, lng: p.lng, speedKmh: p.speedKmh, heading: p.heading, at: p.at })));
}));

export default router;
