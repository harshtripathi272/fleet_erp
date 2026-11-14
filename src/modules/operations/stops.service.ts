import { Types } from 'mongoose';
import { ForbiddenError, NotFoundError } from '../../core/errors/index.js';
import type { Plain } from '../../core/masters/types.js';
import { Trailer } from '../fleet/models/trailer.model.js';
import { Place } from '../geography/models/place.model.js';
import { freightSettings } from '../freight/settings.js';
import { validateStops } from './calc.js';
import { productFacts } from './cargo.service.js';
import { tripGate } from './gate.js';
import { lastReached, working, type ConsignmentP, type StopP } from './legs.js';
import { Consignment } from './models/cargo.model.js';
import { Trip } from './models/trip.model.js';
import type * as S from './operations.schema.js';
import { conflict, log, need, refuse, save, type OpsContext } from './support.js';
import { placeName, presentTrip, refigureStops, truckFacts } from './trips.service.js';

/**
 * A trip's stops beyond the plan (#135, design 3.3 and 3.7.2): what holds the truck, letting it pass, re-ordering
 * and adding stops on the road, and what is on board along the route against the truck's capacity.
 */

const id = (v: unknown) => (v == null ? '' : String(v));

async function tripDoc(tripId: string) {
  const trip = await Trip.findById(tripId);
  if (!trip) throw new NotFoundError('Trip not found');
  return trip;
}

/** The stop that holds the truck now, and why. */
export async function gateOf(tripId: string) {
  const trip = await Trip.findById(tripId).lean<Plain>();
  if (!trip) throw new NotFoundError('Trip not found');
  return { gate: await tripGate(trip) };
}

/** Someone allowed to lets the truck pass a stop that holds it, with the reason; it is logged on the trip. */
export async function passStop(tripId: string, stopId: string, reason: string, ctx: OpsContext) {
  if (!ctx.can('stop-gate-override', 'create')) throw new ForbiddenError('Your role may not let a truck pass a stop that holds it.');
  const trip = await tripDoc(tripId);
  const stops = trip.get('stops') as Plain[];
  const stop = stops.find((s) => id(s._id) === stopId);
  if (!stop) throw new NotFoundError('Stop not found');
  if (stop.gatePassed) throw conflict('The truck may already pass this stop.');
  const at = new Date();
  stop.gatePassed = { at, by: ctx.actorId, byName: ctx.name, reason };
  trip.markModified('stops');
  trip.set('updatedBy', ctx.actorId);
  await save(trip);
  await log(ctx, at, `${ctx.name} let the truck pass ${await placeName(stop.placeId)} before it was ready: ${reason}`, { tripId: trip._id });
  return presentTrip(trip.toObject() as Plain);
}

/**
 * Re-orders the stops the truck has not reached, or adds and removes one (design 3.3). The stops it reached come
 * first, unchanged. A stop a pickup or drop is planned at can't go, and every pickup stays before its drops.
 */
export async function putStops(tripId: string, input: S.PutStopsInput, ctx: OpsContext) {
  need(ctx, 'trips', 'update');
  const trip = await tripDoc(tripId);
  if (trip.get('version') !== input.version) throw conflict('This trip was changed by someone else. Reload it and try again.');
  if (!trip.get('active')) throw conflict('This trip is closed.');
  const settings = await freightSettings();
  if (trip.get('dispatchedAt') && !settings.stopsEditableOnRoad) throw refuse('This company does not change stops once the truck has left. Switch it on in Company → Freight.');
  const current = (trip.toObject() as Plain).stops as StopP[];
  const reached = lastReached(current);
  for (let i = 0; i <= reached; i += 1) {
    const sent = input.stops[i];
    if (!sent || sent.id !== id(current[i]!._id) || sent.placeId !== id(current[i]!.placeId) || sent.kind !== current[i]!.kind) throw refuse("The stops the truck has reached can't move.");
  }
  const problem = validateStops(input.stops, { tripsWithoutCargo: settings.tripsWithoutCargo });
  if (problem) throw refuse(problem);
  const byId = new Map(current.map((s) => [id(s._id), s]));
  const at = new Date();
  for (const p of [...new Set(input.stops.map((s) => s.placeId))]) if (!(await Place.exists({ _id: p, status: 'active' }))) throw refuse('A stop uses a place that was not found or is archived.');
  const next = input.stops.map((s) => {
    const old = s.id ? byId.get(s.id) : undefined;
    if (s.id && !old) throw refuse('A stop sent is not on this trip.');
    return old ? { ...old, placeId: new Types.ObjectId(s.placeId), kind: s.kind } : { _id: new Types.ObjectId(), placeId: new Types.ObjectId(s.placeId), kind: s.kind, legKm: 0, legHours: 0, origin: 'office', addedAt: at, addedBy: ctx.actorId };
  });
  const consignments = working((await Consignment.find({ tripId: trip._id }).lean()) as unknown as ConsignmentP[], trip._id);
  const kept = new Set(next.map((s) => id(s._id)));
  const index = new Map(next.map((s, i) => [id(s._id), i]));
  for (const c of consignments) {
    for (const leg of c.legs) {
      if (leg.status !== 'planned' || !leg.stopId) continue;
      if (!kept.has(id(leg.stopId))) throw refuse(`A stop with a planned pickup or drop can't be removed. Move the pickup or drop of ${c.number} first.`);
      const stop = next[index.get(id(leg.stopId))!]!;
      if (id(stop.placeId) !== id(leg.placeId) || stop.kind !== (leg.kind === 'pickup' ? 'load' : 'offload')) throw refuse(`${c.number} is ${leg.kind === 'pickup' ? 'loaded' : 'dropped'} at that stop: move the ${leg.kind} instead of changing the stop.`);
    }
    const ups = c.legs.filter((l) => l.kind === 'pickup' && l.status !== 'skipped' && index.has(id(l.stopId))).map((l) => index.get(id(l.stopId))!);
    const downs = c.legs.filter((l) => l.kind === 'drop' && l.status !== 'skipped' && index.has(id(l.stopId))).map((l) => index.get(id(l.stopId))!);
    if (ups.length && downs.length && Math.min(...downs) < Math.max(...ups)) throw refuse(`Every pickup comes before its drops: ${c.number} would be dropped before it is loaded.`);
  }
  trip.set('stops', await refigureStops(next as never));
  trip.markModified('stops');
  trip.set('updatedBy', ctx.actorId);
  await save(trip, 'This trip was changed by someone else. Reload it and try again.');
  await log(ctx, at, 'Stops changed', { tripId: trip._id });
  return presentTrip(trip.toObject() as Plain);
}

/** kg and litres one measure counts for against capacity: weighed goods by their unit, liquids by their litres. */
async function dims(productId: unknown, m: { qty?: number; ambientL?: number; unit?: string }) {
  const f = await productFacts(productId);
  const unit = String(m.unit ?? f.unit).toLowerCase();
  const qty = Number(m.qty ?? 0);
  if (f.volumeCorrected || unit === 'l') return { kg: 0, l: Number(m.ambientL ?? qty) };
  if (unit === 'm3' || unit === 'm³') return { kg: 0, l: qty * 1000 };
  if (unit === 'kg') return { kg: qty, l: 0 };
  if (unit === 't') return { kg: qty * 1000, l: 0 };
  return { kg: 0, l: 0 };
}

/**
 * On board along the route, against the truck's limits (design 3.7.3): actual where recorded, planned where not, so
 * planning sees a stretch that would be over before the truck is loaded. It warns; only a pickup is refused.
 */
export async function capacityOf(tripId: string) {
  const trip = await Trip.findById(tripId).lean<Plain>();
  if (!trip) throw new NotFoundError('Trip not found');
  const truck = await truckFacts(trip.vehicleId, false);
  const trailer = trip.trailerId ? await Trailer.findById(trip.trailerId).select('registrationNumber capacityL capacityKg').lean<Plain>() : null;
  const settings = await freightSettings();
  const kgLimits = [truck.capacityT ? { v: truck.capacityT * 1000, from: truck.plate } : undefined, trailer?.capacityKg ? { v: Number(trailer.capacityKg), from: String(trailer.registrationNumber) } : undefined].filter(Boolean) as Array<{ v: number; from: string }>;
  const kg = kgLimits.sort((a, b) => a.v - b.v)[0];
  const l = trailer?.capacityL ? { v: Number(trailer.capacityL), from: String(trailer.registrationNumber) } : undefined;
  const consignments = working((await Consignment.find({ tripId: trip._id }).lean()) as unknown as ConsignmentP[], trip._id);
  const stops = (trip.stops ?? []) as StopP[];
  const tolerance = 1 + settings.capacityTolerancePercent / 100;
  let onKg = 0, onL = 0;
  const planned = [];
  for (const stop of stops) {
    for (const c of consignments) {
      for (const leg of c.legs) {
        if (leg.status === 'skipped' || id(leg.stopId) !== id(stop._id)) continue;
        const sign = leg.kind === 'pickup' ? 1 : -1;
        for (const line of c.lines) {
          const actual = (leg.actual ?? []).find((m) => id(m.lineId) === id(line._id));
          const plannedQty = (leg.planned ?? []).find((p) => id(p.lineId) === id(line._id))?.qty ?? (leg.kind === 'pickup' ? c.legs.filter((x) => x.kind === 'pickup' && x.status !== 'skipped').length === 1 ? line.plannedQty : undefined : c.legs.filter((x) => x.kind === 'drop' && x.status !== 'skipped').length === 1 ? line.plannedQty : undefined);
          const d = await dims(line.productId, (actual ?? { qty: Number(plannedQty ?? 0), unit: String(line.unit) }) as never);
          onKg += sign * d.kg; onL += sign * d.l;
        }
      }
    }
    onKg = Math.max(0, onKg); onL = Math.max(0, onL);
    planned.push({ stopId: id(stop._id), place: await placeName(stop.placeId), kind: stop.kind, kg: Math.round(onKg), l: Math.round(onL), over: Boolean((kg && onKg > kg.v * tolerance) || (l && onL > l.v * tolerance)) });
  }
  const notes: string[] = [];
  if (!kg) notes.push(`No payload set for ${truck.plate}, so the weight can't be checked.`);
  if (!l && consignments.some((c) => c.lines.some((line) => String(line.unit).toLowerCase() === 'l'))) notes.push(`No tank capacity set for ${trailer ? String(trailer.registrationNumber) : truck.plate}, so the litres can't be checked.`);
  const over = planned.filter((p) => p.over);
  if (over.length) notes.push(`Over capacity after ${over.map((p) => p.place).join(', ')}.`);
  // On board now: what is recorded and not yet dropped. A consignment whose every drop is done has nothing left on
  // board but goods the consignee refused that are being brought back (#102 walk: a settled trip showed "On board
  // 0.3 t", which was fuel lost on the road). A trip that has ended has nothing on board.
  let nowKg = 0, nowL = 0;
  const ended = Boolean(trip.endedAt) || trip.active === false && Boolean(trip.dispatchedAt);
  for (const c of ended ? [] : consignments) {
    const drops = c.legs.filter((l) => l.kind === 'drop' && l.status !== 'skipped');
    if (drops.length && drops.every((l) => l.status === 'done')) {
      for (const r of ((c as unknown as Plain).refusals ?? []) as Plain[]) {
        if (r.status === 'decided' && r.outcome !== 'return') continue;
        const line = c.lines.find((x) => id(x._id) === id(r.lineId));
        if (!line) continue;
        const d = await dims(line.productId, { qty: Number(r.qty), unit: String(r.unit) } as never);
        nowKg += d.kg; nowL += d.l;
      }
      continue;
    }
    for (const leg of c.legs) {
      if (leg.status !== 'done') continue;
      for (const m of leg.actual ?? []) {
        const line = c.lines.find((x) => id(x._id) === id(m.lineId));
        if (!line) continue;
        const d = await dims(line.productId, m as never);
        const sign = leg.kind === 'pickup' ? 1 : -1;
        nowKg += sign * d.kg; nowL += sign * d.l;
      }
    }
  }
  return {
    check: settings.capacityCheck, tolerancePercent: settings.capacityTolerancePercent,
    limits: { kg: kg?.v, kgFrom: kg?.from, l: l?.v, lFrom: l?.from },
    onBoard: { kg: Math.max(0, Math.round(nowKg)), l: Math.max(0, Math.round(nowL)) },
    planned, notes,
  };
}
