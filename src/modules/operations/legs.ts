import type { Plain } from '../../core/masters/types.js';
import { cumulativeKm, haversineKm, round, volume20, type LatLng, type Measure } from './calc.js';
import type { TripEvent } from './stages.js';

/**
 * Consignments on a trip, worked out from their legs (#135, consignments design 3.3 and 3.7). Pure: no database.
 * A leg is one pickup or one drop of a consignment; it attaches to a stop of the trip carrying it. From the legs come
 * each consignment's status, the stop that holds the truck, and the trip's "loaded" and "delivered" events.
 */

export interface StopP { _id: unknown; placeId: unknown; kind: string; legKm: number; legHours?: number; arrivedAt?: Date; leftAt?: Date; skipped?: boolean; gatePassed?: Plain; origin?: string; addedAt?: Date; addedBy?: unknown }
export interface LegP { _id: unknown; kind: 'pickup' | 'drop'; sequence: number; placeId?: unknown; stopId?: unknown; tripId?: unknown; status: 'planned' | 'done' | 'skipped'; planned?: Array<{ lineId: unknown; qty?: number; pieces?: number }>; actual?: Array<Plain & { lineId: unknown }>; outcome?: string; recordedAt?: Date; pod?: Plain }
export interface ConsignmentP { _id: unknown; number: string; status: string; tripId?: unknown; legs: LegP[]; lines: Array<Plain & { _id: unknown }>; documents?: Array<Plain>; outcome?: Plain; cancelledAt?: Date; revenue?: Plain }

const id = (v: unknown) => (v == null ? '' : String(v));

/** Nothing more happens to it on its trip. */
export const FINISHED_STATUSES = new Set(['delivered', 'closed', 'cancelled', 'returned', 'written_off']);

export const pickups = (c: { legs: LegP[] }) => c.legs.filter((l) => l.kind === 'pickup' && l.status !== 'skipped');
export const drops = (c: { legs: LegP[] }) => c.legs.filter((l) => l.kind === 'drop' && l.status !== 'skipped');
export const isLoaded = (c: ConsignmentP) => pickups(c).some((l) => l.status === 'done');

/**
 * A consignment's status from its legs (design 3.2.1 and correction 3 in 3.4.7): booked with no trip; assigned until
 * something is loaded; loading, loaded, in transit once the truck has left its last pickup, delivering, delivered;
 * closed once its revenue is frozen. Cancelled, returned and written off come from actions and stay.
 */
export function deriveStatus(c: ConsignmentP, trip?: { stops?: StopP[]; settlementId?: unknown } | null): string {
  if (c.cancelledAt) return 'cancelled';
  const writeOff = c.outcome?.writeOff as Plain | undefined;
  if (writeOff?.status === 'approved') return 'written_off';
  if (c.status === 'draft') return 'draft';
  const ups = pickups(c), downs = drops(c);
  const doneUp = ups.filter((l) => l.status === 'done').length;
  const doneDown = downs.filter((l) => l.status === 'done').length;
  if (c.outcome?.returned) return downs.length && doneDown === downs.length ? 'returned' : 'returning';
  if (!c.tripId) return 'booked';
  if (!doneUp) return 'assigned';
  if (doneUp < ups.length) return 'loading';
  if (downs.length && doneDown === downs.length) {
    const frozen = ['frozen', 'invoiced'].includes(String(c.revenue?.status ?? ''));
    return frozen || trip?.settlementId ? 'closed' : 'delivered';
  }
  if (doneDown) return 'delivering';
  const stops = trip?.stops ?? [];
  const lastPickupStop = ups.map((l) => stops.find((s) => id(s._id) === id(l.stopId))).filter(Boolean).at(-1);
  return lastPickupStop?.leftAt ? 'in_transit' : 'loaded';
}

export const isFinished = (c: ConsignmentP) => FINISHED_STATUSES.has(deriveStatus(c));

/** The consignments a trip is working on: on it now, not cancelled, not drafts. */
export const working = (consignments: ConsignmentP[], tripId: unknown) =>
  consignments.filter((c) => id(c.tripId) === id(tripId) && !c.cancelledAt && c.status !== 'draft' && c.status !== 'cancelled');

/** Every leg attached to each stop, by stop id. */
export function legsByStop(consignments: ConsignmentP[]) {
  const map = new Map<string, Array<{ c: ConsignmentP; leg: LegP }>>();
  for (const c of consignments) for (const leg of c.legs) {
    if (!leg.stopId || leg.status === 'skipped') continue;
    const list = map.get(id(leg.stopId)) ?? [];
    list.push({ c, leg });
    map.set(id(leg.stopId), list);
  }
  return map;
}

/* ---------- The gate ---------- */

export interface GateSettings { leaveStopRequires: string[]; consignmentBy: string; tripsWithoutCargo: boolean; consignmentRateRequired: string }
/** The document types that hold a truck at a stop until they are in (requiredBy "to_leave_stop"), by the step they belong to. */
export interface GateDocType { _id: unknown; name: string; step: string; driverKind?: string }

export interface Gate { index: number; stopId: string; reason: string; driverReason: string; why: 'no_consignment' | 'pickup' | 'drop' | 'document' | 'rate' }

const list = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** Whether a leg has a paper of this type. */
export const hasDocument = (c: ConsignmentP, leg: LegP, type: GateDocType) =>
  (c.documents ?? []).some((d) => id(d.documentTypeId) === id(type._id) && (!d.legId || id(d.legId) === id(leg._id)))
  || (type.driverKind === 'pod' || type.driverKind === 'delivery' ? Boolean(leg.pod?.number || (leg.pod?.docIds as unknown[] | undefined)?.length) : false);

/**
 * The first stop the truck may not pass yet, and why (design 3.7.2). A loading or offloading stop holds the truck
 * while a pickup or drop planned there is not recorded, while a paper that must be in before leaving is missing, and,
 * at a loading stop, while the trip has no consignment at all. Company → Freight relaxes each; a person allowed to
 * can let the truck pass one stop with a reason. With one consignment it says what it said before consignments.
 */
export function stopGate(trip: { _id?: unknown; stops: StopP[] }, all: ConsignmentP[], settings: GateSettings, placeName: (placeId: unknown) => string, docTypes: GateDocType[] = []): Gate | null {
  const consignments = working(all, trip._id);
  const byStop = legsByStop(consignments);
  const single = consignments.length <= 1;
  const requires = new Set(settings.leaveStopRequires);
  for (const [index, stop] of trip.stops.entries()) {
    if (stop.skipped || stop.gatePassed) continue;
    if (stop.kind !== 'load' && stop.kind !== 'offload') continue;
    const here = (byStop.get(id(stop._id)) ?? []).filter(({ c }) => !c.outcome?.writeOff || (c.outcome.writeOff as Plain).status !== 'approved');
    const place = placeName(stop.placeId);
    const gate = (why: Gate['why'], reason: string, driverReason: string): Gate => ({ index, stopId: id(stop._id), reason, driverReason, why });
    if (stop.kind === 'load' && !consignments.length && settings.consignmentBy === 'loading' && !settings.tripsWithoutCargo) {
      return gate('no_consignment', 'Record the loading first.', 'Waiting for Operations to record the loading.');
    }
    if (requires.has('lines')) {
      const open = here.filter(({ leg }) => leg.status === 'planned');
      const up = open.filter(({ leg }) => leg.kind === 'pickup').map(({ c }) => c.number);
      if (up.length) return gate('pickup', single ? 'Record the loading first.' : `Record the loading of ${list([...new Set(up)])} at ${place} first.`, 'Waiting for Operations to record the loading.');
      const down = open.filter(({ leg }) => leg.kind === 'drop').map(({ c }) => c.number);
      if (down.length) return gate('drop', single ? `Record the delivery at ${place} first.` : `Record the delivery of ${list([...new Set(down)])} at ${place} first.`, `Waiting for Operations to record the delivery at ${place}.`);
    }
    if (requires.has('required_documents')) {
      for (const { c, leg } of here) {
        if (leg.status !== 'done') continue;
        const step = leg.kind === 'pickup' ? 'pickup' : 'drop';
        const missing = docTypes.find((t) => t.step === step && !hasDocument(c, leg, t));
        if (missing) return gate('document', `${c.number} needs its ${missing.name.toLowerCase()}.`, `Waiting for Operations to record the ${missing.name.toLowerCase()}.`);
      }
    }
    if (settings.consignmentRateRequired === 'at_loading' && stop.kind === 'load') {
      const unpriced = here.filter(({ c, leg }) => leg.kind === 'pickup' && leg.status === 'done' && (!c.revenue || c.revenue.status === 'unpriced')).map(({ c }) => c.number);
      if (unpriced.length) return gate('rate', `${list([...new Set(unpriced)])} ${unpriced.length > 1 ? 'have' : 'has'} no rate yet.`, 'Waiting for the office to agree the rate.');
    }
  }
  return null;
}

/* ---------- Trip events ---------- */

/**
 * The trip events the legs say have happened (design 3.7.1). Loaded: cargo on board and no planned pickup left
 * before the first drop stop (a backhaul picked up later doesn't un-load it). Delivered: every consignment finished
 * and no pickup still planned. Events are only ever added.
 */
export function deriveTripEvents(trip: { _id?: unknown; stops: StopP[] }, all: ConsignmentP[]): TripEvent[] {
  const consignments = working(all, trip._id).concat(all.filter((c) => id(c.tripId) === id(trip._id) && deriveStatus(c) === 'written_off'));
  const index = new Map(trip.stops.map((s, i) => [id(s._id), i]));
  const events: TripEvent[] = [];
  const legs = consignments.flatMap((c) => c.legs.filter((l) => l.status !== 'skipped').map((leg) => ({ c, leg, at: index.get(id(leg.stopId)) })));
  const firstDrop = Math.min(...legs.filter((x) => x.leg.kind === 'drop' && x.at !== undefined).map((x) => x.at!), Number.POSITIVE_INFINITY);
  const onBoard = consignments.some((c) => isLoaded(c));
  const pickupBeforeDrop = legs.some((x) => x.leg.kind === 'pickup' && x.leg.status === 'planned' && (x.at === undefined || x.at < firstDrop));
  if (onBoard && !pickupBeforeDrop) events.push('loaded');
  const finished = consignments.length > 0 && consignments.every((c) => FINISHED_STATUSES.has(deriveStatus(c)) || Boolean(c.outcome?.transfers && id(c.tripId) !== id(trip._id)));
  const pickupLeft = legs.some((x) => x.leg.kind === 'pickup' && x.leg.status === 'planned');
  if (finished && !pickupLeft && consignments.some((c) => isLoaded(c))) events.push('delivered');
  return events;
}

/* ---------- Quantities ---------- */

/** What one measure counts as when compared with another: fuel at 20 °C, other cargo in its own unit. */
export const comparable = (m: Partial<Measure> | undefined, volumeCorrected: boolean) => (volumeCorrected ? volume20(m) ?? m?.qty ?? 0 : m?.qty ?? 0);

/** A drop's quantity as the consignee took it: what was accepted, else what was offloaded. */
export const dropQty = (m: Plain, volumeCorrected: boolean) => (m.accepted != null && !volumeCorrected ? Number(m.accepted) : comparable(m as unknown as Measure, volumeCorrected));

/** Loaded and delivered totals of one goods line, summed over the legs. */
export function lineTotals(c: { legs: LegP[] }, lineId: unknown, volumeCorrected: boolean) {
  const sum = (kind: 'pickup' | 'drop') => round(c.legs.filter((l) => l.kind === kind && l.status === 'done').flatMap((l) => l.actual ?? []).filter((m) => id(m.lineId) === id(lineId))
    .reduce((s, m) => s + (kind === 'drop' ? dropQty(m, volumeCorrected) : comparable(m as unknown as Measure, volumeCorrected)), 0), 3);
  return { loaded: sum('pickup'), delivered: sum('drop') };
}

/**
 * One line's measures added up, in the shape of a single measure: what the consignment loaded (or delivered) in all.
 * Figures that can't be added (temperature, density) come from the last measure.
 */
export function summedMeasure(measures: Plain[]): Plain | undefined {
  if (!measures.length) return undefined;
  const add = (key: string) => (measures.some((m) => m[key] != null) ? round(measures.reduce((s, m) => s + Number(m[key] ?? 0), 0), 3) : undefined);
  const last = measures.at(-1)!;
  const out: Plain = { qty: add('qty'), unit: last.unit, ambientL: add('ambientL'), tempC: last.tempC, density: last.density, vcf: last.vcf, std20L: add('std20L'), certStd20L: add('certStd20L'), pieces: add('pieces') };
  if (measures.length === 1) Object.assign(out, { gross: last.gross, tare: last.tare, ticketNo: last.ticketNo });
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

/* ---------- Placing legs on the stops ---------- */

export interface PlaceFacts { location?: LatLng }

/** The last stop the truck has reached; new stops go after it. */
export const lastReached = (stops: StopP[]) => stops.reduce((found, s, i) => (s.arrivedAt ? i : found), -1);

/**
 * Where each leg of a consignment happens on the trip (design 3.3): an existing loading (or offloading) stop at the
 * same place that the truck hasn't passed, after the stop the consignment's previous leg uses; otherwise a new stop
 * at the place, put where it adds the least distance, before the end. Legs with no place yet ("to be confirmed")
 * stay off the stops. Returns the new stop list (existing stops kept as they are) and each leg's stop id.
 */
export function placeLegs(stops: StopP[], legs: Array<{ key: string; kind: 'pickup' | 'drop'; placeId?: unknown; stopId?: unknown; status: string }>, places: Map<string, PlaceFacts>, newId: () => unknown, at?: Date, by?: unknown) {
  const out = [...stops];
  const assigned = new Map<string, unknown>();
  const reached = lastReached(out);
  let floor = 0;
  let placedAny = false;
  const km = (a: unknown, b: unknown) => {
    if (id(a) === id(b)) return 0;
    const pa = places.get(id(a))?.location, pb = places.get(id(b))?.location;
    return pa && pb ? haversineKm(pa, pb) : 1000;
  };
  for (const leg of legs) {
    const wanted = leg.kind === 'pickup' ? 'load' : 'offload';
    if (leg.stopId) {
      const i = out.findIndex((s) => id(s._id) === id(leg.stopId));
      if (i >= 0) { assigned.set(leg.key, out[i]!._id); floor = Math.max(floor, i); placedAny = true; continue; }
    }
    if (!leg.placeId) continue;
    // After the stop the consignment's previous leg uses (not at it), and after where the truck has been.
    const start = Math.max(placedAny ? floor + 1 : floor, leg.status === 'done' ? 0 : reached + 1);
    const existing = out.findIndex((s, i) => i >= start && !s.skipped && s.kind === wanted && id(s.placeId) === id(leg.placeId));
    if (existing >= 0) { assigned.set(leg.key, out[existing]!._id); floor = existing; placedAny = true; continue; }
    const end = out.findIndex((s) => s.kind === 'end');
    const last = end < 0 ? out.length : end;
    let best = Math.max(start, 1), cost = Number.POSITIVE_INFINITY;
    for (let i = Math.max(start, 1); i <= last; i += 1) {
      const prev = out[i - 1], next = out[i];
      const added = (prev ? km(prev.placeId, leg.placeId) : 0) + (next ? km(leg.placeId, next.placeId) : 0) - (prev && next ? km(prev.placeId, next.placeId) : 0);
      // On a tie (the same place as a stop beside it), a pickup goes after what is dropped there and a drop before what is loaded.
      if (added < cost - 0.01 || (leg.kind === 'pickup' && added <= cost + 0.01)) { cost = added; best = i; }
    }
    const stop: StopP = { _id: newId(), placeId: leg.placeId, kind: wanted, legKm: 0, origin: 'consignment', ...(at ? { addedAt: at, addedBy: by } : {}) };
    out.splice(best, 0, stop);
    assigned.set(leg.key, stop._id);
    floor = best;
    placedAny = true;
  }
  return { stops: out, assigned };
}

/** A stop that no leg uses any more and the route didn't give: it goes, unless the truck has been there. */
export function unusedStops(stops: StopP[], consignments: ConsignmentP[]) {
  const used = new Set(consignments.flatMap((c) => c.legs.filter((l) => l.status !== 'skipped').map((l) => id(l.stopId))));
  return stops.filter((s) => s.origin === 'consignment' && !s.arrivedAt && !used.has(id(s._id)));
}

/** Kilometres of the consignment's own lead: its first pickup stop to its last drop stop, along the trip's stops. */
export function leadKm(stops: StopP[], c: { legs: LegP[] }) {
  const cum = cumulativeKm(stops);
  const at = (leg?: LegP) => (leg ? stops.findIndex((s) => id(s._id) === id(leg.stopId)) : -1);
  const from = Math.min(...pickups(c).map(at).filter((i) => i >= 0));
  const to = Math.max(...drops(c).map(at).filter((i) => i >= 0));
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return undefined;
  return round(cum[to]! - cum[from]!, 1);
}

/**
 * Whether each stretch of the route is driven loaded, from what is on board after each stop. A trip with no
 * consignments yet falls back to the route: loaded from its first loading point to its last offloading point.
 */
export function loadedStretches(stops: StopP[], consignments: ConsignmentP[]): boolean[] {
  if (!consignments.some((c) => c.legs.some((l) => l.status !== 'skipped' && l.stopId))) {
    const first = stops.findIndex((s) => s.kind === 'load');
    const last = stops.map((s) => s.kind).lastIndexOf('offload');
    return stops.map((_, i) => first >= 0 && i > first && (last < 0 || i <= last));
  }
  const passed = new Map<string, { up: number; down: number; drops: number }>();
  for (const c of consignments) passed.set(id(c._id), { up: 0, down: 0, drops: drops(c).length });
  return stops.map((stop) => {
    const loaded = [...passed.values()].some((p) => p.up > 0 && p.down < Math.max(1, p.drops));
    for (const c of consignments) {
      const p = passed.get(id(c._id))!;
      for (const l of c.legs) if (l.status !== 'skipped' && id(l.stopId) === id(stop._id)) { if (l.kind === 'pickup') p.up += 1; else p.down += 1; }
    }
    return loaded;
  });
}
