import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { type FleetInboundEvent, type InboundCounts, type Position, scrub } from '../../core/connections/index.js';
import { ConflictError, NotFoundError } from '../../core/errors/index.js';
import { logger } from '../../core/logger/index.js';
import type { Plain } from '../../core/masters/types.js';
import { isAreaOn } from '../company/areas.js';
import { onInbound, recordError, recordUse, using } from '../connections/connections.service.js';
import { Vehicle } from '../fleet/models/vehicle.model.js';
import { fleetPolicy } from '../fleet-status/policy.js';
import { ExchangeInboxLog, ExternalRef, PositionHistory, UnmatchedTracker, VehiclePosition } from './models.js';

/*
 * The position store (#136): every tracker reading that reaches us, by a signed call or by asking a service,
 * lands here. A truck is found by the platform's id for it, then its tracker's device id, then its plate. A
 * repeat changes nothing; an older reading never replaces a newer one; a tracker on no known truck is parked.
 */

const DAY = 86_400_000;
/** Same normalising as the truck master's registrationKey: "ALC 4821" and "alc-4821" are one truck. */
export const plateKey = (plate: unknown) => String(plate ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** The key a reading is remembered by: the service's own id, else a hash of what it says. */
export function eventKey(type: string, p: { id?: string; deviceId?: string; registration?: string; externalId?: string; at: Date; lat?: number; lng?: number; place?: unknown }) {
  if (p.id) return `id:${p.id}`;
  const parts = [type, p.externalId ?? '', p.deviceId ?? '', plateKey(p.registration), p.at.toISOString(), p.lat ?? '', p.lng ?? '', JSON.stringify(p.place ?? '')];
  return `h:${createHash('sha1').update(parts.join('|')).digest('hex')}`;
}

/** The truck a reading is about, or nothing: the platform's id for it, the tracker's device id, then the plate. */
export async function resolveVehicle(connectionId: unknown, p: { deviceId?: string; registration?: string; externalId?: string }): Promise<Types.ObjectId | undefined> {
  const ids = [p.externalId, p.deviceId].filter(Boolean) as string[];
  if (connectionId && ids.length) {
    const ref = await ExternalRef.findOne({ connectionId, entity: 'vehicle', externalId: { $in: ids } }).select('localId').lean();
    if (ref) return ref.localId as Types.ObjectId;
  }
  if (p.deviceId) {
    const byDevice = await Vehicle.findOne({ gpsDeviceId: p.deviceId, status: 'active' }).select('_id').lean();
    if (byDevice) return byDevice._id as Types.ObjectId;
  }
  const key = plateKey(p.registration);
  if (key) {
    const byPlate = await Vehicle.findOne({ registrationKey: key, status: 'active' }).select('_id').lean();
    if (byPlate) return byPlate._id as Types.ObjectId;
  }
  return undefined;
}

/** What a reading is parked under while no truck is matched: the platform's id, else the device id, else the plate. */
const parkKey = (p: Position) => (p.externalId ? `ext:${p.externalId}` : p.deviceId ? `dev:${p.deviceId}` : `plate:${plateKey(p.registration)}`);

/**
 * Keeps one reading on its truck. Newer than what is held: it becomes the truck's position. Older (or the
 * same time): history only. Answers which.
 */
export async function applyPosition(vehicleId: Types.ObjectId, p: Position, connectionId: unknown, historyDays: number): Promise<'stored' | 'late'> {
  const source = p.source ?? 'device';
  const set = {
    lat: p.lat, lng: p.lng, geo: { type: 'Point', coordinates: [p.lng, p.lat] }, at: p.at, receivedAt: new Date(), source, simulated: source === 'simulator',
    ...(connectionId ? { connectionId } : {}), ...(p.deviceId ? { deviceId: p.deviceId } : {}), ...(p.id ? { eventId: p.id } : {}),
  };
  const optional = { speedKmh: p.speedKmh, heading: p.heading, odometerKm: p.odometerKm, ignition: p.ignition, accuracyM: p.accuracyM };
  const unset = Object.fromEntries(Object.entries(optional).filter(([, v]) => v === undefined).map(([k]) => [k, 1]));
  const present = Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined));
  let outcome: 'stored' | 'late' = 'stored';
  try {
    // Matches only a held position that is older; with none held it is inserted. A newer one held makes the
    // insert collide with the truck's unique index: that is how "older" is detected, in one atomic step.
    await VehiclePosition.updateOne({ vehicleId, at: { $lt: p.at } }, { $set: { ...set, ...present }, ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { upsert: true });
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
    outcome = 'late';
  }
  await PositionHistory.create({
    vehicleId, lat: p.lat, lng: p.lng, at: p.at, speedKmh: p.speedKmh, heading: p.heading, source, ...(connectionId ? { connectionId } : {}),
    ...(outcome === 'late' ? { late: true } : {}), expireAt: new Date(Date.now() + historyDays * DAY),
  });
  return outcome;
}

/** Remembers an event by its key. False when it was already seen: then nothing more is done with it. */
async function firstTime(connectionId: unknown, key: string, type: string, at: Date, dedupeDays: number) {
  try {
    await ExchangeInboxLog.create({ connectionId, eventKey: key, type, at, expireAt: new Date(Date.now() + dedupeDays * DAY) });
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return false;
    throw err;
  }
}

/** Every reading from one call, or one round of asking a service. Answers what became of them. */
export async function recordPositions(connection: Plain | undefined, positions: Position[]): Promise<Required<Omit<InboundCounts, 'notes' | 'rejected'>>> {
  const counts = { stored: 0, duplicate: 0, unmatched: 0 };
  if (!positions.length) return counts;
  const { thresholds } = await fleetPolicy();
  const connectionId = connection?._id;
  // Oldest first, so within one call the newest reading is the one a truck ends with.
  for (const p of [...positions].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const key = eventKey('position', p);
    if (connectionId && !(await firstTime(connectionId, key, 'position', p.at, thresholds.dedupeDays))) { counts.duplicate += 1; continue; }
    const vehicleId = await resolveVehicle(connectionId, p);
    if (!vehicleId) {
      counts.unmatched += 1;
      if (connectionId) {
        await park(connectionId, p);
        await ExchangeInboxLog.updateOne({ connectionId, eventKey: key }, { $set: { outcome: 'unmatched' } });
      }
      continue;
    }
    const outcome = await applyPosition(vehicleId, p, connectionId, thresholds.historyDays);
    if (connectionId) await ExchangeInboxLog.updateOne({ connectionId, eventKey: key }, { $set: { outcome, vehicleId } });
    if (outcome === 'stored') counts.stored += 1;
  }
  return counts;
}

/** A reading for a tracker on no known truck: kept with its count, its newest reading on top. */
async function park(connectionId: unknown, p: Position) {
  const now = new Date();
  const last = { lat: p.lat, lng: p.lng, at: p.at, speedKmh: p.speedKmh, heading: p.heading, source: p.source ?? 'device', odometerKm: p.odometerKm, ignition: p.ignition, eventId: p.id };
  const key = parkKey(p);
  const ids = { ...(p.deviceId ? { deviceId: p.deviceId } : {}), ...(p.registration ? { registration: p.registration } : {}), ...(p.externalId ? { externalId: p.externalId } : {}) };
  const expireAt = new Date(now.getTime() + 7 * DAY);
  await UnmatchedTracker.updateOne({ connectionId, key }, { $setOnInsert: { firstSeenAt: now, last }, $set: { lastSeenAt: now, expireAt, ...ids }, $inc: { count: 1 } }, { upsert: true });
  await UnmatchedTracker.updateOne({ connectionId, key, 'last.at': { $lt: p.at } }, { $set: { last } });
}

/** Trackers parked for want of a truck, newest first, for the Connections screen. */
export async function listUnmatched(connectionId?: string) {
  const rows = await UnmatchedTracker.find(connectionId ? { connectionId } : {}).sort({ lastSeenAt: -1 }).limit(200).lean();
  return rows.map((r) => ({ id: String(r._id), connectionId: String(r.connectionId), key: r.key, deviceId: r.deviceId, registration: r.registration, externalId: r.externalId, count: r.count, firstSeenAt: r.firstSeenAt, lastSeenAt: r.lastSeenAt, last: r.last }));
}

/** "Match to a truck": the tracker is that truck's from now on, and its last reading becomes the truck's position. */
export async function matchUnmatched(id: string, vehicleId: string) {
  const parked = await UnmatchedTracker.findById(id).lean();
  if (!parked) throw new NotFoundError('That tracker is no longer waiting to be matched');
  const vehicle = await Vehicle.findOne({ _id: vehicleId, status: 'active' }).select('_id registrationNumber').lean();
  if (!vehicle) throw new NotFoundError('No active truck with this id');
  const externalId = parked.externalId ?? parked.deviceId;
  if (externalId) {
    const taken = await ExternalRef.findOne({ connectionId: parked.connectionId, entity: 'vehicle', localId: vehicle._id }).lean();
    if (taken && taken.externalId !== externalId) throw new ConflictError(`${String(vehicle.registrationNumber)} is already matched to tracker ${taken.externalId}`);
    await ExternalRef.updateOne({ connectionId: parked.connectionId, entity: 'vehicle', externalId }, { $set: { localId: vehicle._id, source: 'manual' } }, { upsert: true });
  }
  const { thresholds } = await fleetPolicy();
  const last = parked.last as unknown as Position & { source?: Position['source']; eventId?: string };
  const outcome = await applyPosition(vehicle._id as Types.ObjectId, {
    deviceId: parked.deviceId ?? '', lat: last.lat, lng: last.lng, at: new Date(last.at), speedKmh: last.speedKmh ?? undefined, heading: last.heading ?? undefined,
    source: last.source ?? 'device', ...(last.eventId ? { id: last.eventId } : {}),
  }, parked.connectionId, thresholds.historyDays);
  await UnmatchedTracker.deleteOne({ _id: parked._id });
  return { vehicleId: String(vehicle._id), matchedBy: externalId ? 'tracker id' : 'plate only (no id to remember)', position: outcome };
}

/** The latest position of each truck asked for (all when none are named). */
export async function latestPositions(vehicleIds?: unknown[]) {
  return VehiclePosition.find(vehicleIds ? { vehicleId: { $in: vehicleIds } } : {}).lean();
}

/* Wiring: signed calls from trackers and platforms, and services that are asked */

/** Events other than positions are remembered (so repeats are dropped) but not acted on yet: arrivals from GPS come next. */
async function recordOtherEvents(connection: Plain, events: FleetInboundEvent[]) {
  const { thresholds } = await fleetPolicy();
  let duplicate = 0;
  let kept = 0;
  for (const e of events) {
    if (e.type === 'position') continue;
    const key = eventKey(e.type, { ...e, deviceId: e.vehicle?.deviceId, registration: e.vehicle?.registration, externalId: e.vehicle?.externalId });
    if (await firstTime(connection._id, key, e.type, e.at, thresholds.dedupeDays)) {
      kept += 1;
      await ExchangeInboxLog.updateOne({ connectionId: connection._id, eventKey: key }, { $set: { outcome: 'recorded' } });
    } else duplicate += 1;
  }
  return { duplicate, kept };
}

onInbound(async (kind, connection, result): Promise<InboundCounts | void> => {
  if (kind !== 'gps' && kind !== 'fleet-exchange') return;
  if (!(await isAreaOn('tracking'))) return { notes: ['Tracking is switched off for this company, so positions were not kept'] };
  const counts: InboundCounts = await recordPositions(connection, result.positions ?? []);
  const others = await recordOtherEvents(connection, result.events ?? []);
  counts.duplicate = (counts.duplicate ?? 0) + others.duplicate;
  if (others.kept) counts.notes = [`${others.kept} geofence or other event${others.kept === 1 ? ' was' : 's were'} recorded; acting on them (arrivals from GPS) is not built yet`];
  return counts;
});

/** One round of asking the connected tracker service for positions, when it is one that is asked (Traccar). */
export async function pollTrackers(): Promise<number> {
  if (!(await isAreaOn('tracking'))) return 0;
  const now = await using('gps');
  if (now.via !== 'connection' || !now.connection || now.provider.inbound || now.provider.simulated) return 0;
  try {
    const positions = await now.capability.positions();
    await recordUse(now.connection._id);
    return (await recordPositions(now.connection, positions)).stored;
  } catch (err) {
    const message = scrub(err instanceof Error ? err.message : String(err), now.connection as never);
    await recordError(now.connection._id, `Asking for positions failed: ${message}`);
    logger.warn({ err: message }, 'Tracker poll failed');
    return 0;
  }
}

let poller: NodeJS.Timeout | undefined;
let lastPoll = 0;
/** Asks every `pollSeconds` (the company's policy), checking each 15 seconds whether it is time. */
export function startTrackerPoller() {
  if (poller) return;
  poller = setInterval(() => {
    void (async () => {
      const { thresholds } = await fleetPolicy();
      if (Date.now() - lastPoll < thresholds.pollSeconds * 1000) return;
      lastPoll = Date.now();
      await pollTrackers();
    })().catch((err) => logger.error({ err }, 'Tracker poller failed'));
  }, 15_000);
  poller.unref();
}
export function stopTrackerPoller() { if (poller) clearInterval(poller); poller = undefined; }
