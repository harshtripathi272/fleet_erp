import { Schema, Types, model } from 'mongoose';
import type { LatLng } from '../../core/connections/index.js';
import { logger } from '../../core/logger/index.js';
import { recordError, recordUse, using } from '../connections/connections.service.js';

/**
 * Road distance and shape between two places from the routing connection (#60), kept per pair of places
 * and connection, so each pair is asked once. With no routing connection, or only its Simulated stand-in,
 * nothing is asked: trips keep the straight line × the company's road factor, as before.
 */
const roadLegSchema = new Schema({
  fromPlaceId: { type: Schema.Types.ObjectId, ref: 'Place', required: true },
  toPlaceId: { type: Schema.Types.ObjectId, ref: 'Place', required: true },
  connectionId: { type: Schema.Types.ObjectId, ref: 'Connection', required: true },
  provider: { type: String, required: true },
  km: { type: Number, required: true, min: 0 },
  hours: { type: Number, min: 0 },
  /** [lng, lat] points along the road, for the maps. */
  shape: { type: [[Number]], default: [] },
  at: { type: Date, required: true },
}, { versionKey: false });
roadLegSchema.index({ fromPlaceId: 1, toPlaceId: 1, connectionId: 1 }, { unique: true });
export const RoadLeg = model('RoadLeg', roadLegSchema);

const ASK_TIMEOUT_MS = 10_000;

/** The routing connection when it's a real service; the straight-line stand-in adds nothing to the road factor. */
async function router() {
  const inUse = await using('routing');
  return inUse.via === 'connection' && !inUse.provider.simulated && inUse.connection ? inUse : null;
}

export interface Place { id: string; location?: LatLng }

/** The road between two places, or null when there is no routing service or it couldn't answer. */
export async function roadLeg(from: Place, to: Place): Promise<{ km: number; hours?: number } | null> {
  if (!from.location || !to.location || from.id === to.id) return null;
  const inUse = await router();
  if (!inUse) return null;
  const connectionId = new Types.ObjectId(String(inUse.connection!._id));
  const key = { fromPlaceId: new Types.ObjectId(from.id), toPlaceId: new Types.ObjectId(to.id), connectionId };
  const kept = await RoadLeg.findOne(key).select('km hours').lean<{ km: number; hours?: number }>();
  if (kept) return { km: kept.km, hours: kept.hours };
  try {
    const answer = await inUse.capability.route([from.location, to.location], AbortSignal.timeout(ASK_TIMEOUT_MS));
    const leg = { km: Math.round(answer.km), hours: answer.hours === undefined ? undefined : Math.round(answer.hours * 10) / 10 };
    await RoadLeg.updateOne(key, { $set: { ...leg, provider: inUse.provider.key, shape: answer.shape, at: new Date() } }, { upsert: true });
    await recordUse(connectionId);
    return leg;
  } catch (err) {
    // The trip is still planned, on the straight line; the connection shows why.
    logger.warn({ err, from: from.id, to: to.id }, 'Routing service did not answer; straight line used');
    await recordError(connectionId, `Route not found: ${(err as Error).message}`);
    return null;
  }
}

/** The kept road shapes for pairs of places ("from-to" → [lng, lat] points), from the routing connection in use. */
export async function roadShapes(pairs: Array<[string, string]>): Promise<Record<string, Array<[number, number]>>> {
  const inUse = await router();
  if (!inUse || !pairs.length) return {};
  const legs = await RoadLeg.find({
    connectionId: new Types.ObjectId(String(inUse.connection!._id)),
    $or: pairs.map(([a, b]) => ({ fromPlaceId: new Types.ObjectId(a), toPlaceId: new Types.ObjectId(b) })),
  }).select('fromPlaceId toPlaceId shape').lean<Array<{ fromPlaceId: unknown; toPlaceId: unknown; shape: Array<[number, number]> }>>();
  return Object.fromEntries(legs.filter((l) => l.shape.length > 1).map((l) => [`${l.fromPlaceId}-${l.toPlaceId}`, l.shape]));
}
