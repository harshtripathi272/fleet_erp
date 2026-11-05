import { Schema, Types, model } from 'mongoose';
import type { LatLng, Position } from '../../core/connections/index.js';
import { haversineKm } from '../../core/connections/providers/routing.js';
import { logger } from '../../core/logger/index.js';
import type { Plain } from '../../core/masters/types.js';
import { onInbound, recordError, recordUse, using } from '../connections/connections.service.js';
import { Vehicle } from '../fleet/models/vehicle.model.js';
import { Place } from '../geography/models/place.model.js';
import { cumulativeKm } from '../operations/calc.js';
import { Consignment } from '../operations/models/cargo.model.js';
import { Trip } from '../operations/models/trip.model.js';
import { operationsSettings } from '../operations/settings.js';
import { save, type OpsContext } from '../operations/support.js';
import { arrivalRefusal, arriveAt } from '../operations/trips.service.js';
import { RoadLeg } from './routing.service.js';

/**
 * GPS trackers (#60). Each position names its tracker; the truck with that GPS device ID gets it. On a trip
 * on the road, the position moves the truck along the route, and a stop counts as arrived once the truck
 * has stayed inside the place's geofence for the company's dwell time, and as left once it is out again.
 * Positions are pushed to a connection's webhook, or asked for every so often from trackers that need it.
 */

/** Each truck's latest tracker position, and the stop it is waiting inside (for the dwell time). */
const vehiclePositionSchema = new Schema({
  vehicleId: { type: Schema.Types.ObjectId, ref: 'Vehicle', required: true },
  deviceId: { type: String, required: true },
  connectionId: { type: Schema.Types.ObjectId, ref: 'Connection' },
  lat: { type: Number, required: true },
  lng: { type: Number, required: true },
  speedKmh: Number,
  heading: Number,
  at: { type: Date, required: true },
  inside: { type: new Schema({ tripId: Schema.Types.ObjectId, index: Number, since: Date }, { _id: false }), default: undefined },
}, { versionKey: false, timestamps: { createdAt: false, updatedAt: true } });
vehiclePositionSchema.index({ vehicleId: 1 }, { unique: true });
export const VehiclePosition = model('VehiclePosition', vehiclePositionSchema);

const TRACKER: OpsContext = { name: 'Tracker', desk: 'operations', can: () => false, roles: [] };
/** A driver's report this recent keeps a tracker from overriding it, when the phone wins. */
const PHONE_FRESH_MS = 30 * 60_000;
/** A truck counts as gone from a stop a little beyond the geofence, so a fix wobbling on its edge doesn't flap. */
const LEAVE_FACTOR = 1.2;

export interface Received { accepted: number; matched: number; moved: number; unknownDevices: string[] }

/** Positions from a GPS connection (pushed or asked for): each one to its truck, oldest first. */
export async function receivePositions(connection: Plain, positions: Position[]): Promise<Received> {
  const settings = await operationsSettings();
  // "auto": on for a real tracker service, off for the Simulated one.
  const detect = settings.arrivalDetection === 'on' || (settings.arrivalDetection === 'auto' && connection.provider !== 'simulated');
  const result: Received = { accepted: positions.length, matched: 0, moved: 0, unknownDevices: [] };
  for (const p of [...positions].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const vehicle = await Vehicle.findOne({ gpsDeviceId: p.deviceId, status: 'active' }).select('_id').lean<{ _id: Types.ObjectId }>();
    if (!vehicle) { if (!result.unknownDevices.includes(p.deviceId)) result.unknownDevices.push(p.deviceId); continue; }
    result.matched++;
    const before = await VehiclePosition.findOne({ vehicleId: vehicle._id }).lean<Plain>();
    if (before && new Date(String(before.at)) >= p.at) continue;
    const state = { vehicleId: vehicle._id, deviceId: p.deviceId, connectionId: connection._id, lat: p.lat, lng: p.lng, speedKmh: p.speedKmh, heading: p.heading, at: p.at, inside: before?.inside as Plain | undefined };
    const trip = await Trip.findOne({ vehicleId: vehicle._id, active: true, dispatchedAt: { $exists: true }, endedAt: { $exists: false }, cancelledAt: { $exists: false } });
    if (trip && (await moveTrip(trip, p, state, { source: settings.positionSource, dwellMs: settings.arrivalDwellMinutes * 60_000, detect }))) result.moved++;
    await VehiclePosition.updateOne({ vehicleId: vehicle._id }, { $set: state, ...(state.inside ? {} : { $unset: { inside: 1 } }) }, { upsert: true });
  }
  if (result.unknownDevices.length) logger.info({ devices: result.unknownDevices.slice(0, 10) }, 'Positions for trackers no truck has as its GPS device ID');
  return result;
}

/** Which report moves the truck, by the company's setting: the newest, the tracker, or the driver's phone. */
function wins(current: Plain | undefined, p: Position, source: string) {
  if (!current?.at) return true;
  const at = new Date(String(current.at)).getTime();
  if (current.source === 'gps' && at >= p.at.getTime()) return false;
  if (source === 'tracker') return true;
  if (source === 'phone') return !(current.source === 'driver' && Date.now() - at < PHONE_FRESH_MS);
  return p.at.getTime() > at;
}

/** Applies one position to a trip on the road. False when the setting gave the move to another report. */
async function moveTrip(trip: InstanceType<typeof Trip>, p: Position, state: { inside?: Plain }, rules: { source: string; dwellMs: number; detect: boolean }) {
  const current = trip.get('tracking')?.toObject?.() as Plain | undefined;
  if (!wins(current, p, rules.source)) return false;
  const stops = trip.get('stops') as Array<{ placeId: Types.ObjectId; kind: string; legKm: number; arrivedAt?: Date; leftAt?: Date }>;
  const places = new Map((await Place.find({ _id: { $in: stops.map((s) => s.placeId) } }).select('location geofenceRadiusM').lean<Array<{ _id: unknown; location?: LatLng; geofenceRadiusM?: number }>>()).map((x) => [String(x._id), x]));
  const placeOf = (i: number) => places.get(String(stops[i]!.placeId));
  const metresTo = (i: number) => { const l = placeOf(i)?.location; return l ? haversineKm(p, l) * 1000 : Infinity; };
  const radius = (i: number) => placeOf(i)?.geofenceRadiusM ?? 300;

  if (rules.detect) {
    // Arrival: the first stop not reached yet that the truck is inside, once it has stayed the dwell time.
    const lastArrived = stops.reduce((last, s, i) => (s.arrivedAt ? i : last), 0);
    const inside = stops.findIndex((s, i) => i > lastArrived && !s.arrivedAt && metresTo(i) <= radius(i));
    if (inside < 0) state.inside = undefined;
    else {
      const was = state.inside && String(state.inside.tripId) === String(trip._id) && state.inside.index === inside ? new Date(String(state.inside.since)) : p.at;
      state.inside = { tripId: trip._id, index: inside, since: was };
      if (p.at.getTime() - was.getTime() >= rules.dwellMs) {
        const refusal = await arrivalRefusal(trip, inside);
        if (refusal) logger.info({ trip: trip.get('number'), stop: inside, refusal }, 'Tracker shows the truck at a stop the cargo has not reached yet');
        else {
          await arriveAt(trip, inside, was, TRACKER, 'gps');
          state.inside = undefined;
        }
      }
    }
    // Departure: a stop reached and not left, which the truck is now well outside.
    stops.forEach((s, i) => {
      if (s.arrivedAt && !s.leftAt && metresTo(i) > radius(i) * LEAVE_FACTOR && p.at >= s.arrivedAt) s.leftAt = p.at;
    });
  }

  const km = await kmAlong(trip, stops, places, p, Number(current?.km ?? 0));
  trip.set('tracking', { km, speed: p.speedKmh ?? 0, heading: p.heading ?? Number(current?.heading ?? 0), at: p.at, source: 'gps', lat: p.lat, lng: p.lng });
  trip.markModified('stops');
  await save(trip);
  return true;
}

/**
 * How far along the route the truck is: the nearest point on the legs not yet behind it (the road shape
 * when the routing service gave one, else the straight line), never backwards. Held at loading until the
 * load is recorded and at offloading until the delivery is, as the trip panel shows it.
 */
async function kmAlong(trip: InstanceType<typeof Trip>, stops: Array<{ placeId: Types.ObjectId; kind: string; legKm: number }>, places: Map<string, { location?: LatLng }>, p: LatLng, previous: number) {
  const cum = cumulativeKm(stops);
  const shapes = new Map((await RoadLeg.find({ $or: stops.slice(1).map((s, i) => ({ fromPlaceId: stops[i]!.placeId, toPlaceId: s.placeId })) }).select('fromPlaceId toPlaceId shape').lean<Array<{ fromPlaceId: unknown; toPlaceId: unknown; shape: Array<[number, number]> }>>())
    .map((l) => [`${l.fromPlaceId}-${l.toPlaceId}`, l.shape]));
  let best = { metres: Infinity, km: previous };
  for (let i = 1; i < stops.length; i++) {
    if (cum[i]! < previous - 0.5) continue;
    const a = places.get(String(stops[i - 1]!.placeId))?.location;
    const b = places.get(String(stops[i]!.placeId))?.location;
    const shape = shapes.get(`${stops[i - 1]!.placeId}-${stops[i]!.placeId}`) ?? (a && b ? [[a.lng, a.lat], [b.lng, b.lat]] as Array<[number, number]> : []);
    const near = nearestOn(shape, p);
    if (near && near.metres < best.metres) best = { metres: near.metres, km: cum[i - 1]! + near.fraction * stops[i]!.legKm };
  }
  let km = Math.max(previous, Math.round(best.km * 10) / 10);
  const loadAt = stops.findIndex((s) => s.kind === 'load');
  const offloadAt = stops.findIndex((s) => s.kind === 'offload');
  const consignments = await Consignment.find({ tripId: trip._id }).select('delivered').lean();
  if (!consignments.length && loadAt >= 0) km = Math.min(km, cum[loadAt]!);
  else if (consignments.some((c) => !c.delivered) && offloadAt >= 0) km = Math.min(km, cum[offloadAt]!);
  return km;
}

/** The point of a line ([lng, lat] points) nearest to p: how far away, and how far along the line (0–1). */
function nearestOn(shape: Array<[number, number]>, p: LatLng): { metres: number; fraction: number } | null {
  if (shape.length < 2) return null;
  // Flat x/y in kilometres around p: exact enough at the scale of a geofence.
  const kx = 111.32 * Math.cos((p.lat * Math.PI) / 180);
  const xy = ([lng, lat]: [number, number]) => [(lng - p.lng) * kx, (lat - p.lat) * 110.57] as const;
  const lengths: number[] = [];
  for (let i = 1; i < shape.length; i++) { const [x1, y1] = xy(shape[i - 1]!); const [x2, y2] = xy(shape[i]!); lengths.push(Math.hypot(x2 - x1, y2 - y1)); }
  const total = lengths.reduce((a, b) => a + b, 0) || 1;
  let best = { metres: Infinity, fraction: 0 };
  let along = 0;
  for (let i = 1; i < shape.length; i++) {
    const [x1, y1] = xy(shape[i - 1]!);
    const [x2, y2] = xy(shape[i]!);
    const len = lengths[i - 1]!;
    const t = len ? Math.max(0, Math.min(1, -(x1 * (x2 - x1) + y1 * (y2 - y1)) / (len * len))) : 0;
    const d = Math.hypot(x1 + t * (x2 - x1), y1 + t * (y2 - y1)) * 1000;
    if (d < best.metres) best = { metres: d, fraction: (along + t * len) / total };
    along += len;
  }
  return best;
}

/** Asks the GPS connection for positions, when its tracker service is asked rather than pushing. */
export async function pollTrackers(): Promise<Received | null> {
  const inUse = await using('gps');
  if (inUse.via !== 'connection' || inUse.provider.simulated || !inUse.connection) return null;
  try {
    const positions = await inUse.capability.positions(AbortSignal.timeout(20_000));
    await recordUse(inUse.connection._id);
    return await receivePositions(inUse.connection, positions);
  } catch (err) {
    await recordError(inUse.connection._id, `Positions could not be fetched: ${(err as Error).message}`);
    return null;
  }
}

let timer: NodeJS.Timeout | undefined;
/** Inside the server (IN_PROCESS_JOBS): asks every trackerPollSeconds; nothing happens without such a connection. */
export function startTrackerPolling() {
  const tick = async () => {
    try { await pollTrackers(); } catch (err) { logger.error({ err }, 'Tracker poll failed'); }
    timer = setTimeout(() => void tick(), (await operationsSettings()).trackerPollSeconds * 1000);
    timer.unref();
  };
  timer = setTimeout(() => void tick(), 5_000);
  timer.unref();
}
export const stopTrackerPolling = () => { if (timer) clearTimeout(timer); timer = undefined; };

// Positions pushed to a GPS connection's webhook come here.
onInbound(async (kind, connection, result) => {
  if (kind === 'gps' && result.positions?.length) await receivePositions(connection, result.positions);
});
