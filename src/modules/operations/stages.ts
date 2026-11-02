import type { HydratedDocument } from 'mongoose';
import { NotFoundError } from '../../core/errors/index.js';
import type { Plain } from '../../core/masters/types.js';
import { Role } from '../roles/role.model.js';
import { TripStage } from '../trips/models/tripStage.model.js';
import { TripType } from '../trips/models/tripType.model.js';
import { Trip } from './models/trip.model.js';
import { activeRecord, conflict, log, refuse, save, type OpsContext } from './support.js';

/**
 * A trip follows its trip type's configured stages, not a fixed sequence. A stage completes on a trip
 * event or by hand (by the stage's actor role). The events keep their physical order: a truck is loaded
 * before it delivers. A stage completing on a later event also completes the event stages before it.
 */
export const EVENT_ORDER = ['created', 'funding_requested', 'funded', 'dispatched', 'loaded', 'arrived_offloading', 'delivered', 'ended'] as const;
export type TripEvent = (typeof EVENT_ORDER)[number];
const rank = (event: string) => EVENT_ORDER.indexOf(event as TripEvent);

export interface StageStep { stageId: string; code: string; name: string; completesOn: string; actorRoleKey?: string; isFinal: boolean; completedAt?: Date; completedBy?: string }

/** The trip type to use: the one chosen, or the company's default. Trips without one have no stages. */
export async function tripTypeFor(tripTypeId?: string) {
  if (tripTypeId) return activeRecord(TripType, tripTypeId, 'trip type');
  return (await TripType.findOne({ isDefault: true, status: 'active' }).lean()) as Plain | null;
}

/** The type's active stages, copied onto the trip so later edits to the type don't change running trips. */
export async function stageSnapshot(tripTypeId: unknown): Promise<StageStep[]> {
  if (!tripTypeId) return [];
  const stages = await TripStage.find({ tripTypeId, status: 'active' }).sort({ order: 1 }).lean();
  const roles = new Map((await Role.find({ _id: { $in: stages.map((s) => String(s.actorRoleId ?? '')).filter(Boolean) } }).select('key').lean()).map((r) => [String(r._id), String(r.key)]));
  return stages.map((s) => ({
    stageId: String(s._id), code: String(s.code), name: String(s.name), completesOn: String(s.completesOn ?? 'manual'),
    actorRoleKey: s.actorRoleId ? roles.get(String(s.actorRoleId)) : undefined, isFinal: Boolean(s.isFinal),
  }));
}

const currentIndex = (stages: StageStep[]) => stages.findIndex((s) => !s.completedAt);

/** The stage an event belongs to: the first event stage whose event comes at or after it. */
function stageOf(stages: StageStep[], event: TripEvent) {
  const i = stages.findIndex((s) => s.completesOn !== 'manual' && rank(s.completesOn) >= rank(event));
  return i < 0 ? stages.length : i;
}

/** Refuses an action while the trip waits at a manual stage that comes before the action's stage. */
export function assertStageAllows(trip: Plain, event: TripEvent) {
  const stages = (trip.stages ?? []) as StageStep[];
  const at = currentIndex(stages);
  if (at < 0 || stages[at]!.completesOn !== 'manual') return;
  if (at < stageOf(stages, event)) throw conflict(`Complete "${stages[at]!.name}" first.`);
}

/** Records an event and completes every event stage it (or an earlier event) finishes, stopping at a manual stage. */
export function recordEvent(trip: HydratedDocument<any>, event: TripEvent, at: Date, actorId?: string) {
  const events = new Set<string>(trip.get('events') ?? []);
  events.add(event);
  trip.set('events', [...events]);
  const latest = Math.max(...[...events].map(rank));
  const stages = (trip.get('stages') ?? []) as StageStep[];
  for (const stage of stages) {
    if (stage.completedAt) continue;
    if (stage.completesOn === 'manual' || rank(stage.completesOn) > latest) break;
    stage.completedAt = at;
    stage.completedBy = actorId;
  }
  trip.markModified('stages');
}

/** Records an event on a trip loaded fresh, retrying if someone else saved the trip in between. */
export async function fireEvent(tripId: unknown, event: TripEvent, at: Date, actorId?: string) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const trip = await Trip.findById(tripId);
    if (!trip) return;
    recordEvent(trip, event, at, actorId);
    try {
      await trip.save();
      return;
    } catch (err) {
      if ((err as { name?: string }).name !== 'VersionError') throw err;
    }
  }
}

/** Completes the manual stage the trip is waiting at. Only the stage's actor role (or, without one, trip editors) may. */
export async function completeStage(tripId: string, ctx: OpsContext) {
  const at = new Date();
  const trip = await Trip.findById(tripId);
  if (!trip) throw new NotFoundError('Trip not found');
  const stages = (trip.get('stages') ?? []) as StageStep[];
  const i = currentIndex(stages);
  if (i < 0) throw conflict('Every stage of this trip is complete.');
  const stage = stages[i]!;
  if (stage.completesOn !== 'manual') throw conflict(`"${stage.name}" completes by itself when the trip gets there.`);
  const allowed = stage.actorRoleKey ? ctx.roles.includes(stage.actorRoleKey) || ctx.can('*', 'update') : ctx.can('trips', 'update');
  if (!allowed) throw refuse(`"${stage.name}" is done by the ${stage.actorRoleKey} role.`);
  stage.completedAt = at;
  stage.completedBy = ctx.actorId;
  trip.markModified('stages');
  // Event stages right after it may already be due.
  const last = ((trip.get('events') ?? []) as TripEvent[]).sort((a, b) => rank(b) - rank(a))[0];
  if (last) recordEvent(trip, last, at, ctx.actorId);
  await save(trip);
  await log(ctx, at, `${stage.name} complete`, { tripId: trip._id });
  return trip;
}

/** The stage a trip is at, for the API. */
export function currentStage(trip: Plain) {
  const stages = (trip.stages ?? []) as StageStep[];
  const i = currentIndex(stages);
  if (!stages.length) return null;
  const stage = i < 0 ? stages.at(-1)! : stages[i]!;
  return { stageId: stage.stageId, code: stage.code, name: stage.name, completesOn: stage.completesOn, done: i < 0 };
}
