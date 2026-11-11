import { Types, type HydratedDocument } from 'mongoose';
import { ForbiddenError, NotFoundError } from '../../core/errors/index.js';
import * as Fmt from '../../core/format/regional.js';
import type { Plain } from '../../core/masters/types.js';
import { Product } from '../cargo/models/product.model.js';
import { ShortagePolicy } from '../cargo/models/shortagePolicy.model.js';
import { Trailer } from '../fleet/models/trailer.model.js';
import { Place } from '../geography/models/place.model.js';
import { Party } from '../parties/models/party.model.js';
import { TripType } from '../trips/models/tripType.model.js';
import { consignmentTypeByCode, documentTypeByCode } from '../freight/defaults.js';
import { ConsignmentDocumentType, ConsignmentType } from '../freight/models/freight.model.js';
import { freightSettings } from '../freight/settings.js';
import { reprice } from '../freight/pricing.js';
import { refreshProfit } from '../freight/profit/profit.service.js';
import { routeApproval } from './approvals.js';
import { cumulativeKm, measure, round, shortageLitres, volume20, type Measure } from './calc.js';
import { amountOf, fuelChecks, markRecorded, productFacts, quantityOf, type CargoKind } from './cargo.service.js';
import {
  comparable, deriveStatus, deriveTripEvents, drops, isFinished, isLoaded, lastReached, leadKm, lineTotals, pickups, placeLegs, summedMeasure, unusedStops, working,
  type ConsignmentP, type LegP, type StopP,
} from './legs.js';
import { Consignment, DriverDocument } from './models/cargo.model.js';
import { Trip } from './models/trip.model.js';
import { announce } from './notices.js';
import type * as S from './operations.schema.js';
import { customValues, stepCustom } from './placements.js';
import { operationsSettings } from './settings.js';
import { recordEvent } from './stages.js';
import { assertStageAllows } from './stages.js';
import {
  activeRecord, baseCurrency, conflict, currencyInfo, driverThread, formatMoney, litres, loadOr404, log, need, nextNumber, post, present, queue, refuse, save, toBase,
  type OpsContext,
} from './support.js';
import { arriveAt, driverName, partyName, placeName, refigureStops, truckFacts } from './trips.service.js';

/**
 * Consignments on a trip (#135, consignments design 3.2, 3.3, 3.7.3): created with the trip, at loading or on the
 * road; each with its own goods, parties, pickups and drops anywhere on the route, papers and POD. Loading and
 * delivery are recorded per pickup and per drop. A company with one load and one drop sees what it saw before.
 */

type Doc = HydratedDocument<any>;
const id = (v: unknown) => (v == null ? '' : String(v));
const oid = () => new Types.ObjectId();
const CARGO_KIND_NAME: Record<CargoKind, string> = { volume: 'volume-corrected liquids', weighed: 'weighed goods', counted: 'counted goods' };

/* ---------- Reading ---------- */

/** May see what a consignment is worth: the revenue area's sensitive switch (Owner and Finance by default). */
export const seesRevenue = (can: OpsContext['can']) => can('consignment-revenue', 'sensitive');

/**
 * A consignment for the API. Its loaded and delivered totals of the first goods line are given again as `load` and
 * `delivered`, with `productId`, `invoiceNo`, `inTransit` and `writeOff`, so screens and integrations written for
 * one load per trip keep working for one release (design 3.10). Revenue only for those who may see it.
 */
export function presentConsignment(doc: Plain, can?: OpsContext['can']): Plain {
  const out = present(doc);
  const legs = (doc.legs ?? []) as LegP[];
  const first = (doc.lines as Plain[] | undefined)?.[0];
  const of = (kind: 'pickup' | 'drop') => legs.filter((l) => l.kind === kind && l.status === 'done').flatMap((l) => (l.actual ?? []).filter((m) => id(m.lineId) === id(first?._id)));
  const load = summedMeasure(of('pickup'));
  const allDropped = drops(doc as unknown as ConsignmentP).length > 0 && drops(doc as unknown as ConsignmentP).every((l) => l.status === 'done');
  const lastDrop = legs.filter((l) => l.kind === 'drop' && l.status === 'done').at(-1);
  const delivered = allDropped ? summedMeasure(of('drop')) : undefined;
  const invoice = ((doc.documents ?? []) as Plain[]).find((d) => d.number && legs.some((l) => l.kind === 'pickup' && id(l._id) === id(d.legId)));
  out.legs = ((out.legs ?? []) as Plain[]).map(({ _id, ...leg }) => ({ id: _id, ...leg }));
  out.lines = ((out.lines ?? []) as Plain[]).map(({ _id, ...line }) => ({ id: _id, ...line }));
  out.documents = ((out.documents ?? []) as Plain[]).map(({ _id, ...d }) => ({ id: _id, ...d }));
  Object.assign(out, {
    productId: first ? String(first.productId) : undefined,
    invoiceNo: invoice?.number,
    load,
    delivered: delivered ? { ...delivered, at: lastDrop?.recordedAt, podNo: lastDrop?.pod?.number } : undefined,
    inTransit: isLoaded(doc as unknown as ConsignmentP) && !isFinished(doc as unknown as ConsignmentP),
    writeOff: (doc.outcome as Plain | undefined)?.writeOff,
    returned: (doc.outcome as Plain | undefined)?.returned,
    transfers: (doc.outcome as Plain | undefined)?.transfers,
  });
  // A rate is money as much as revenue is: both only for those who may see it.
  if (can && !seesRevenue(can)) { delete out.revenue; delete out.rate; }
  return out;
}

export async function getConsignment(cid: string, ctx?: OpsContext) {
  const doc = await Consignment.findById(cid).lean();
  if (!doc) throw new NotFoundError('Consignment not found');
  return presentConsignment(doc as Plain, ctx?.can);
}

const DATE_FIELD = { booked: 'bookedAt', loaded: 'loadedAt', delivered: 'deliveredAt' } as const;
const TABS: Record<string, Plain> = {
  all: {},
  to_load: { status: { $in: ['assigned', 'loading'] } },
  on_road: { status: { $in: ['loaded', 'in_transit', 'delivering'] } },
  to_deliver: { status: { $in: ['loaded', 'in_transit', 'delivering'] } },
  waiting_pod: { status: { $in: ['delivered', 'closed'] }, legs: { $elemMatch: { kind: 'drop', status: 'done', 'pod.number': { $exists: false }, 'pod.docIds.0': { $exists: false } } } },
  unpriced: { $or: [{ revenue: { $exists: false } }, { 'revenue.status': 'unpriced' }], status: { $nin: ['cancelled', 'draft'] } },
};

/** The consignments list, paged on the server, for the Consignments screen and the trip's tab (design 3.11.6). */
export async function listConsignments(query: S.ConsignmentsQuery, ctx?: OpsContext) {
  const filter: Plain = { ...(TABS[query.tab ?? 'all'] ?? {}) };
  for (const key of ['tripId', 'customerId', 'consignorPartyId', 'consigneePartyId'] as const) if (query[key]) filter[key] = new Types.ObjectId(query[key]);
  if (query.productId) filter['lines.productId'] = new Types.ObjectId(query.productId);
  if (query.status) filter.status = { $in: query.status.split(',') };
  if (query.revenueStatus) filter['revenue.status'] = query.revenueStatus;
  if (query.shortage) filter['shortage.status'] = query.shortage;
  if (query.podMissing) filter.legs = { $elemMatch: { kind: 'drop', status: 'done', 'pod.number': { $exists: false }, 'pod.docIds.0': { $exists: false } } };
  if (query.from || query.to) {
    const field = DATE_FIELD[query.dateField ?? 'booked'];
    filter[field] = { ...(query.from ? { $gte: query.from } : {}), ...(query.to ? { $lte: query.to } : {}) };
  }
  if (query.q) {
    const rx = { $regex: query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const [parties, trips] = await Promise.all([
      Party.find({ name: rx }).select('_id').limit(50).lean(),
      Trip.find({ number: rx }).select('_id').limit(50).lean(),
    ]);
    const partyIds = parties.map((p) => p._id);
    filter.$and = [...((filter.$and as Plain[] | undefined) ?? []), { $or: [
      { number: rx }, { 'references.customerRef': rx }, { 'references.lrNo': rx }, { 'references.orderNo': rx }, { 'consignee.name': rx }, { 'consignor.name': rx },
      { customerId: { $in: partyIds } }, { consigneePartyId: { $in: partyIds } }, { consignorPartyId: { $in: partyIds } }, { tripId: { $in: trips.map((t) => t._id) } },
      { 'documents.number': rx },
    ] }];
  }
  const sort = query.tripId ? { bookedAt: 1, _id: 1 } : { loadedAt: -1, bookedAt: -1, _id: -1 };
  const [rows, total] = await Promise.all([
    Consignment.find(filter).sort(sort as never).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
    Consignment.countDocuments(filter),
  ]);
  return { data: rows.map((r) => presentConsignment(r as Plain, ctx?.can)), total, page: query.page, limit: query.limit };
}

/* ---------- Making one ---------- */

async function tripOf(tripId: unknown) {
  const trip = await Trip.findById(tripId);
  if (!trip) throw new NotFoundError('Trip not found');
  return trip;
}

/** The type a new consignment starts as: chosen, the company's default, the trip type's, else by what is carried. */
async function typeFor(input: { consignmentTypeId?: string }, trip: Plain, firstProduct: Plain): Promise<Plain | null> {
  if (input.consignmentTypeId) return activeRecord(ConsignmentType, input.consignmentTypeId, 'consignment type');
  const settings = await freightSettings();
  const tripType = trip.tripTypeId ? await TripType.findById(trip.tripTypeId).select('defaultConsignmentTypeId').lean<Plain>() : null;
  for (const candidate of [settings.defaultConsignmentTypeId, tripType?.defaultConsignmentTypeId]) {
    if (!candidate) continue;
    const found = await ConsignmentType.findOne({ _id: candidate, status: 'active' }).lean<Plain>();
    if (found) return found;
  }
  return consignmentTypeByCode(firstProduct.volumeCorrected ? 'BULK_LIQUID' : 'FTL');
}

interface Prepared { data: Plain; type: Plain | null; facts: Map<string, Awaited<ReturnType<typeof productFacts>>> }

/**
 * Everything that can refuse a consignment before anything is saved: its products, parties, type rules, the
 * company's settings. The New trip form checks every consignment this way before the trip is made.
 */
export async function prepareConsignment(input: S.InlineConsignmentInput, trip: Plain, ctx: OpsContext): Promise<Prepared> {
  const settings = await freightSettings();
  const facts = new Map<string, Awaited<ReturnType<typeof productFacts>>>();
  const lines: Plain[] = [];
  for (const line of input.lines) {
    const f = facts.get(line.productId) ?? (await productFacts(line.productId));
    facts.set(line.productId, f);
    lines.push({ _id: line.id ? new Types.ObjectId(line.id) : oid(), productId: f.product._id, description: line.description, plannedQty: line.plannedQty, unit: f.unit, pieces: line.pieces, grossKg: line.grossKg, volumeM3: line.volumeM3, declaredValue: line.declaredValue, hazard: line.hazard });
  }
  const type = await typeFor(input, trip, facts.get(input.lines[0]!.productId)!.product);
  const customerId = input.customerId ?? String(trip.customerId);
  await activeRecord(Party, customerId, 'customer');
  for (const [key, label] of [['consignorPartyId', 'consignor'], ['consigneePartyId', 'consignee'], ['brokerPartyId', 'broker']] as const) if (input[key]) await activeRecord(Party, input[key], label);
  const consigneeIsParty = Boolean(input.consigneePartyId);
  if ((settings.consigneeMustBeParty || type?.requireConsigneeParty) && !consigneeIsParty && input.consignee) throw refuse('Choose the consignee from the customers: this company needs a record for every consignee.');
  if (settings.consigneePhoneRequired && !input.consigneePartyId && !input.consignee?.phone) throw refuse("Enter the consignee's phone number.");
  const consignorPartyId = input.consignorPartyId ?? (!input.consignor && settings.consignorDefault === 'customer' ? customerId : undefined);
  const data: Plain = {
    consignmentTypeId: type?._id, customerId, consignorPartyId, consignor: input.consignor, consigneePartyId: input.consigneePartyId ?? (!input.consignee ? customerId : undefined),
    consignee: input.consignee, brokerPartyId: input.brokerPartyId, paymentTerms: input.paymentTerms ?? 'to_be_billed', requiredBy: input.requiredBy, lines,
    // Only someone who may see money sets a rate; anyone else's is ignored rather than refused.
    references: input.references, rate: seesRevenue(ctx.can) ? input.rate ?? undefined : undefined, notes: input.notes, custom: await stepCustom('consignments', 'booking', input.custom),
  };
  if (!ctx.can('consignments', 'create')) throw new ForbiddenError('Your role does not allow "create" on consignments');
  return { data, type, facts };
}

/** Legs as the person planned them, or the usual one pickup and one drop: the trip's next loading point and the offloading point after it. */
function plannedLegs(input: S.InlineConsignmentInput['legs'], trip: Plain, lines: Plain[], type: Plain | null, lateSplit: string): Plain[] {
  const stops = (trip.stops ?? []) as StopP[];
  const toLine = (p: { lineId?: string; line?: number; qty?: number; pieces?: number }) => {
    const line = p.lineId ? lines.find((l) => id(l._id) === p.lineId) : lines[p.line ?? 0];
    if (!line) throw refuse('A planned quantity names a goods line that is not on this consignment.');
    return { lineId: line._id, qty: p.qty, pieces: p.pieces };
  };
  let legs: Plain[];
  if (input?.length) {
    legs = input.map((l, i) => ({
      _id: l.id ? new Types.ObjectId(l.id) : oid(), kind: l.kind, sequence: i + 1, placeId: l.placeId ? new Types.ObjectId(l.placeId) : undefined, stopId: l.stopId ? new Types.ObjectId(l.stopId) : undefined,
      status: 'planned', plannedAt: l.plannedAt, planned: l.planned?.map(toLine), contact: l.contact, note: l.note,
    }));
    for (const leg of legs) if (leg.stopId && !leg.placeId) leg.placeId = stops.find((s) => id(s._id) === id(leg.stopId))?.placeId;
  } else {
    const reached = lastReached(stops);
    const load = stops.findIndex((s, i) => s.kind === 'load' && !s.skipped && i > reached);
    const pickupAt = load >= 0 ? load : stops.findIndex((s) => s.kind === 'load' && !s.skipped);
    const drop = stops.findIndex((s, i) => s.kind === 'offload' && !s.skipped && i > Math.max(pickupAt, reached));
    if (pickupAt < 0) throw refuse('Add a loading point to the trip, or say where this consignment is loaded.');
    legs = [
      { _id: oid(), kind: 'pickup', sequence: 1, placeId: stops[pickupAt]!.placeId, stopId: stops[pickupAt]!._id, status: 'planned' },
      { _id: oid(), kind: 'drop', sequence: 2, placeId: drop >= 0 ? stops[drop]!.placeId : undefined, stopId: drop >= 0 ? stops[drop]!._id : undefined, status: 'planned' },
    ];
  }
  const ups = legs.filter((l) => l.kind === 'pickup'), downs = legs.filter((l) => l.kind === 'drop');
  if (!ups.length) throw refuse('Say where the consignment is loaded.');
  if (!downs.length) throw refuse('Say where the consignment is dropped, or leave the drop to be confirmed.');
  if (legs.findIndex((l) => l.kind === 'drop') < legs.map((l) => l.kind).lastIndexOf('pickup')) throw refuse('Every pickup comes before the drops.');
  const name = String(type?.name ?? 'This consignment');
  if (type && !type.multiDrop && downs.length > 1) throw refuse(`A ${name.toLowerCase()} is dropped at one place. Choose a consignment type that allows several drops.`);
  if (type && !type.multiPickup && ups.length > 1) throw refuse(`A ${name.toLowerCase()} is loaded at one place. Choose a consignment type that allows several pickups.`);
  if (ups.some((l) => !l.placeId)) throw refuse('Choose where each pickup is.');
  const lateOk = lateSplit === 'always' || (lateSplit === 'by_type' && Boolean(type?.splitDecidedLate));
  if (downs.some((l) => !l.placeId) && !lateOk) throw refuse('Choose where it is dropped. This consignment type does not leave drops to be confirmed.');
  return legs;
}

/** Puts a consignment's legs on the trip's stops, adding stops where needed, and works the legs' km out again. */
export async function attach(trip: Doc, consignment: Doc, ctx: OpsContext, others?: Plain[]) {
  const settings = await freightSettings();
  const stops = (trip.toObject() as Plain).stops as StopP[];
  // Legs done on another trip (before a transfer) stay where they were; only this trip's legs are placed.
  const own = new Set(stops.map((s) => id(s._id)));
  const legs = (((consignment.toObject() as Plain).legs ?? []) as Plain[]).filter((l) => l.status === 'planned' || (l.status === 'done' && own.has(id(l.stopId))));
  const places = new Map((await Place.find({ _id: { $in: legs.map((l) => l.placeId).filter(Boolean) as never[] } }).select('location').lean()).map((p) => [String(p._id), p as Plain]));
  for (const s of stops) if (!places.has(id(s.placeId))) places.set(id(s.placeId), (await Place.findById(s.placeId).select('location').lean()) as Plain ?? {});
  const placed = placeLegs(stops, legs.map((l) => ({ key: id(l._id), kind: l.kind as 'pickup' | 'drop', placeId: l.placeId, stopId: l.status === 'skipped' ? undefined : l.stopId, status: String(l.status) })), places as never, oid, new Date(), ctx.actorId);
  const added = placed.stops.length - stops.length;
  if (added > 0 && trip.get('dispatchedAt') && !settings.stopsEditableOnRoad) throw refuse('This company does not add stops once the truck has left. Plan this consignment at stops already on the route, or switch it on in Company → Freight.');
  for (const leg of consignment.get('legs') as Plain[]) {
    if (leg.status !== 'planned') continue;
    const stopId = placed.assigned.get(id(leg._id));
    (leg as Plain).stopId = stopId;
    (leg as Plain).tripId = stopId ? trip._id : undefined;
  }
  consignment.markModified('legs');
  const all = [...(others ?? (await Consignment.find({ tripId: trip._id, _id: { $ne: consignment._id } }).lean())), consignment.toObject()] as unknown as ConsignmentP[];
  const unused = new Set(unusedStops(placed.stops, all).map((s) => id(s._id)));
  const next = placed.stops.filter((s) => !unused.has(id(s._id)));
  if (added || unused.size) {
    trip.set('stops', await refigureStops(next as never));
    trip.markModified('stops');
  }
  consignment.set('leadKm', leadKm(next, consignment.toObject() as never));
  return { added, removed: unused.size };
}

/** Makes a consignment on a trip. The trip is saved with any stop its legs needed. */
export async function createOnTrip(trip: Doc, input: S.InlineConsignmentInput, ctx: OpsContext, prepared?: Prepared) {
  need(ctx, 'consignments', 'create');
  const at = new Date();
  if (!trip.get('active')) throw conflict('This trip is closed.');
  const settings = await freightSettings();
  const others = await Consignment.find({ tripId: trip._id, status: { $nin: ['cancelled', 'draft'] } }).lean();
  if (settings.maxConsignmentsPerTrip && others.length >= settings.maxConsignmentsPerTrip) throw refuse(settings.maxConsignmentsPerTrip === 1 ? 'This trip already has its consignment. This company carries one per trip.' : `This trip already has ${others.length} consignments, the most this company puts on one trip.`);
  const plain = trip.toObject() as Plain;
  const ready = prepared ?? (await prepareConsignment(input, plain, ctx));
  const legs = plannedLegs(input.legs, plain, ready.data.lines as Plain[], ready.type, settings.lateSplit);
  const consignment = new Consignment({
    ...ready.data, number: await nextNumber('consignments', 'CN', at), tripId: trip._id, legs, bookedAt: at, status: 'assigned',
    movements: [{ tripId: trip._id, from: at, reason: 'assigned', by: ctx.actorId }], createdBy: ctx.actorId, updatedBy: ctx.actorId,
  });
  const placed = await attach(trip, consignment, ctx, others as Plain[]);
  consignment.set('status', deriveStatus(consignment.toObject() as never, plain as never));
  await save(consignment);
  if (placed.added || placed.removed) {
    trip.set('updatedBy', ctx.actorId);
    await save(trip);
    if (trip.get('dispatchedAt')) await tellDriverStops(trip, ctx, `${consignment.get('number')} was added`);
  }
  await reprice(String(consignment._id), ctx);
  await log(ctx, at, `${consignment.get('number')} added: ${await describe(consignment.toObject() as Plain)}`, { tripId: trip._id, entity: 'consignments', entityId: consignment._id });
  return (await Consignment.findById(consignment._id).lean()) as Plain;
}

export async function createConsignment(input: S.CreateConsignmentInput, ctx: OpsContext) {
  const { tripId, ...rest } = input;
  const trip = await tripOf(tripId);
  return presentConsignment(await createOnTrip(trip, rest, ctx), ctx.can);
}

/** "38,000 L diesel for Puma Energy, Dar es Salaam → Lusaka". */
async function describe(c: Plain) {
  const line = (c.lines as Plain[])[0]!;
  const product = await Product.findById(line.productId).select('name').lean();
  const qty = line.plannedQty ? `${amountOf(Number(line.plannedQty), String(line.unit))} ` : '';
  const legs = c.legs as Plain[];
  const from = await placeName(legs.find((l) => l.kind === 'pickup')?.placeId);
  const to = legs.filter((l) => l.kind === 'drop').at(-1)?.placeId ? await placeName(legs.filter((l) => l.kind === 'drop').at(-1)!.placeId) : 'to be confirmed';
  return `${qty}${String(product?.name ?? '').toLowerCase()} for ${await consigneeName(c)}, ${from} → ${to}`;
}

export async function consigneeName(c: Plain) {
  return (c.consignee as Plain | undefined)?.name ? String((c.consignee as Plain).name) : await partyName(c.consigneePartyId ?? c.customerId);
}

/** Tells the driver the stops changed, in order, with what happens at each. */
async function tellDriverStops(trip: Doc, ctx: OpsContext, why: string) {
  const driverId = trip.get('driverId');
  if (!driverId) return;
  const stops = (trip.toObject() as Plain).stops as StopP[];
  const reached = lastReached(stops);
  const ahead = stops.map((s, i) => ({ s, i })).filter(({ s, i }) => i > reached && (s.kind === 'load' || s.kind === 'offload'));
  const rows: Array<[string, string]> = [];
  for (const [n, { s }] of ahead.entries()) rows.push([`${n + 1}`, `${s.kind === 'load' ? 'Load at' : 'Offload at'} ${await placeName(s.placeId)}`]);
  await post(driverThread(driverId), new Date(), {
    title: `Your stops changed · ${trip.get('number')}`, text: `${why}. ${rows.length ? `Next: ${rows.map((r) => r[1]).join('; ')}.` : ''}`.trim(), rows,
    wa: { template: 'stops_changed', values: [String(trip.get('number')), rows.map((r) => `${r[0]}) ${r[1]}`).join(', ') || 'no stops left'] },
  }, ctx);
}

/* ---------- Changing one ---------- */

async function editable(cid: string, version?: number) {
  const consignment = await loadOr404(Consignment, cid, 'Consignment');
  if (version !== undefined && consignment.get('version') !== version) throw conflict('This consignment was changed by someone else. Reload it and try again.');
  if (['cancelled', 'written_off', 'returned'].includes(String(consignment.get('status')))) throw conflict('This consignment is finished with.');
  return consignment;
}

/** Edit the details: parties, goods, references. Goods already loaded keep their line. */
export async function updateConsignment(cid: string, input: S.UpdateConsignmentInput, ctx: OpsContext) {
  need(ctx, 'consignments', 'update');
  const consignment = await editable(cid, input.version);
  const trip = await tripOf(consignment.get('tripId'));
  const { version: _v, lines, ...rest } = input;
  // Someone who may not see money can't see the rate, so can't change or clear it either.
  if (!seesRevenue(ctx.can)) delete (rest as { rate?: unknown }).rate;
  const current = consignment.toObject() as Plain;
  if (lines) {
    const used = new Set((current.legs as Plain[]).filter((l) => l.status === 'done').flatMap((l) => ((l.actual ?? []) as Plain[]).map((m) => id(m.lineId))));
    for (const lineId of used) if (!lines.some((l) => l.id === lineId)) throw refuse('A goods line that was loaded cannot be removed.');
  }
  const ready = await prepareConsignment({ ...(current as Plain), ...rest, lines: lines ?? (current.lines as Plain[]).map((l) => ({ ...l, id: id(l._id), _id: undefined, unit: undefined })) } as never, trip.toObject() as Plain, { ...ctx, can: (r, a) => ctx.can(r, a === 'create' ? 'update' : a) });
  const keep: Plain = {};
  for (const key of Object.keys(rest)) keep[key] = ready.data[key];
  if (lines) keep.lines = ready.data.lines;
  if (rest.custom) keep.custom = await stepCustom('consignments', 'booking', rest.custom, current.custom as Plain | undefined);
  consignment.set({ ...keep, updatedBy: ctx.actorId });
  await save(consignment, 'This consignment was changed by someone else. Reload it and try again.');
  await reprice(cid, ctx);
  await log(ctx, new Date(), `${consignment.get('number')} changed`, { tripId: trip._id, entity: 'consignments', entityId: consignment._id });
  return getConsignment(cid, ctx);
}

/**
 * Replace the planned pickups and drops: the split-delivery save (design 3.11.5). Done legs stay as they were; the
 * planned ones are what the person sent. New places get stops after the truck's position, stops nobody needs any more
 * go, and the driver is told the new stop list.
 */
export async function putLegs(cid: string, input: S.PutLegsInput, ctx: OpsContext) {
  need(ctx, 'consignments', 'update');
  const at = new Date();
  const consignment = await editable(cid, input.version);
  const trip = await tripOf(consignment.get('tripId'));
  if (!trip.get('active')) throw conflict('This trip is closed.');
  const settings = await freightSettings();
  const current = consignment.toObject() as Plain;
  const done = (current.legs as Plain[]).filter((l) => l.status === 'done');
  const sent = new Map(input.legs.filter((l) => l.id).map((l) => [l.id!, l]));
  for (const leg of done) {
    const again = sent.get(id(leg._id));
    if (again && (again.placeId ?? id(leg.placeId)) !== id(leg.placeId)) throw refuse('A pickup or drop that is done cannot move. Correct it instead.');
  }
  const planned = input.legs.filter((l) => !l.id || !done.some((d) => id(d._id) === l.id));
  const type = current.consignmentTypeId ? await ConsignmentType.findById(current.consignmentTypeId).lean<Plain>() : null;
  const legs = plannedLegs([...done.map((d) => ({ id: id(d._id), kind: d.kind, placeId: id(d.placeId) || undefined })), ...planned] as never, trip.toObject() as Plain, current.lines as Plain[], type, settings.lateSplit);
  // Done legs come back exactly as they were.
  const merged: Plain[] = legs.map((l) => done.find((d) => id(d._id) === id(l._id)) ?? l).map((l, i) => ({ ...l, sequence: i + 1 }));
  // Each line's planned drops must add up to what is on board, unless the rest is left to be confirmed.
  for (const line of current.lines as Plain[]) {
    const f = await productFacts(line.productId);
    const loaded = lineTotals({ legs: done } as never, line._id, f.volumeCorrected).loaded || Number(line.plannedQty ?? 0);
    const dropLegs = merged.filter((l) => l.kind === 'drop');
    const planned = dropLegs.reduce((s, l) => s + (l.status === 'done' ? lineTotals({ legs: [l] } as never, line._id, f.volumeCorrected).delivered : Number(((l.planned ?? []) as Plain[]).find((p) => id(p.lineId) === id(line._id))?.qty ?? (dropLegs.length === 1 ? loaded : 0))), 0);
    const left = round(loaded - planned, 3);
    if (Math.abs(left) > 0.001 && !input.leaveRest && dropLegs.length > 1 && loaded) {
      throw refuse(left > 0 ? `${amountOf(left, String(line.unit))} is not placed on a drop yet. Put it on a drop, or leave the rest to be confirmed.` : `The drops add up to ${amountOf(-left, String(line.unit))} more than is on board.`);
    }
  }
  consignment.set({ legs: merged, updatedBy: ctx.actorId });
  const placed = await attach(trip, consignment, ctx);
  consignment.set('status', deriveStatus(consignment.toObject() as never, trip.toObject() as never));
  await save(consignment, 'This consignment was changed by someone else. Reload it and try again.');
  trip.set('updatedBy', ctx.actorId);
  await save(trip);
  const dropsNow = merged.filter((l) => l.kind === 'drop');
  if (trip.get('dispatchedAt') && (placed.added || placed.removed)) {
    const list = [];
    for (const [n, l] of dropsNow.entries()) {
      const qty = ((l.planned ?? []) as Plain[])[0]?.qty;
      list.push(`${n + 1} ${l.placeId ? await placeName(l.placeId) : 'to be confirmed'}${qty ? ` ${amountOf(Number(qty), String((current.lines as Plain[])[0]!.unit))}` : ''}`);
    }
    await tellDriverStops(trip, ctx, `Your drops for ${consignment.get('number')} changed: ${list.join(', ')}`);
  }
  await reprice(cid, ctx);
  await log(ctx, at, `${consignment.get('number')}: ${dropsNow.length} drop${dropsNow.length === 1 ? '' : 's'} planned${placed.added ? `, ${placed.added} stop${placed.added === 1 ? '' : 's'} added` : ''}`, { tripId: trip._id, entity: 'consignments', entityId: consignment._id });
  await announce('consignment.split', trip.toObject() as Plain, ctx, { ref: { kind: 'consignments', id: consignment._id }, variables: { 'consignment.number': String(consignment.get('number')) } });
  return getConsignment(cid, ctx);
}

/** Takes a consignment off before anything was loaded, with the reason. Its stops go when nothing else needs them. */
export async function cancelConsignment(cid: string, input: { version: number; reason: string }, ctx: OpsContext) {
  need(ctx, 'consignments', 'update');
  const consignment = await editable(cid, input.version);
  if (isLoaded(consignment.toObject() as never)) throw conflict("It is loaded. Say what happens to the load with \"Can't deliver\".");
  const at = new Date();
  consignment.set({ cancelledAt: at, cancelReason: input.reason, status: 'cancelled', updatedBy: ctx.actorId });
  for (const leg of consignment.get('legs') as Plain[]) leg.status = 'skipped';
  consignment.markModified('legs');
  await save(consignment);
  const trip = await Trip.findById(consignment.get('tripId'));
  if (trip) {
    const all = (await Consignment.find({ tripId: trip._id }).lean()) as unknown as ConsignmentP[];
    const unused = new Set(unusedStops((trip.toObject() as Plain).stops as StopP[], all).map((s) => id(s._id)));
    if (unused.size) {
      trip.set('stops', await refigureStops(((trip.toObject() as Plain).stops as StopP[]).filter((s) => !unused.has(id(s._id))) as never));
      await save(trip);
    }
    await log(ctx, at, `${consignment.get('number')} cancelled: ${input.reason}`, { tripId: trip._id, entity: 'consignments', entityId: consignment._id });
    await afterLegs(trip._id, at, ctx);
  }
  return getConsignment(cid, ctx);
}

/** A trip that won't load (cancelled or stopped) takes its planned consignments with it. */
export async function cancelPlanned(tripId: unknown, reason: string, ctx: OpsContext) {
  const at = new Date();
  for (const c of await Consignment.find({ tripId, status: { $in: ['assigned', 'booked'] } })) {
    c.set({ cancelledAt: at, cancelReason: reason, status: 'cancelled', updatedBy: ctx.actorId });
    for (const leg of c.get('legs') as Plain[]) leg.status = 'skipped';
    c.markModified('legs');
    await save(c);
  }
}

/* ---------- Recording pickups and drops ---------- */

/** After the legs change: each consignment's status, the trip's events, and its profit. */
export async function afterLegs(tripId: unknown, at: Date, ctx: OpsContext) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const trip = await Trip.findById(tripId);
    if (!trip) return [];
    const consignments = await Consignment.find({ tripId: trip._id });
    const plainTrip = trip.toObject() as Plain;
    for (const c of consignments) {
      const status = deriveStatus(c.toObject() as never, plainTrip as never);
      if (c.get('status') !== status && !['cancelled', 'draft'].includes(String(c.get('status')))) { c.set('status', status); await save(c); }
    }
    const before = new Set((trip.get('events') ?? []) as string[]);
    const events = deriveTripEvents(plainTrip as never, consignments.map((c) => c.toObject()) as never);
    const fresh = events.filter((e) => !before.has(e));
    if (!fresh.length) { await refreshProfit(String(trip._id)).catch(() => undefined); return []; }
    for (const e of fresh) recordEvent(trip, e, at, ctx.actorId);
    try {
      await trip.save();
      await refreshProfit(String(trip._id)).catch(() => undefined);
      return fresh;
    } catch (err) {
      if ((err as { name?: string }).name !== 'VersionError') throw err;
    }
  }
  return [];
}

/** On board the trip now, by measure: kg of weighed goods, litres of liquids. */
async function onBoard(tripId: unknown, extra: Array<{ productId: unknown; m: Plain }>) {
  const consignments = await Consignment.find({ tripId }).lean();
  let kg = 0, l = 0;
  const add = async (productId: unknown, m: Plain, sign: number) => {
    const f = await productFacts(productId);
    const unit = String(m.unit ?? f.unit).toLowerCase();
    if (f.volumeCorrected || unit === 'l') l += sign * Number(m.ambientL ?? m.qty ?? 0);
    else if (unit === 'm3' || unit === 'm³') l += sign * Number(m.qty ?? 0) * 1000;
    else if (unit === 'kg') kg += sign * Number(m.qty ?? 0);
    else if (unit === 't') kg += sign * Number(m.qty ?? 0) * 1000;
  };
  for (const c of consignments) {
    const lines = new Map(((c.lines ?? []) as Plain[]).map((line) => [id(line._id), line.productId]));
    for (const leg of (c.legs ?? []) as Plain[]) {
      if (leg.status !== 'done') continue;
      for (const m of (leg.actual ?? []) as Plain[]) await add(lines.get(id(m.lineId)), m, leg.kind === 'pickup' ? 1 : -1);
    }
  }
  for (const x of extra) await add(x.productId, x.m, 1);
  return { kg: Math.max(0, round(kg, 3)), l: Math.max(0, round(l, 0)) };
}

/**
 * The truck's capacity against what will be on board after this pickup (design 3.7.3, correction 8): weighed goods
 * against the smaller of the truck's payload and the trailer's, liquids against the trailer's litres. The company's
 * policy decides whether going over refuses, warns or is not checked; a truck with no figure is not blocked.
 */
async function checkCapacity(trip: Doc, extra: Array<{ productId: unknown; m: Plain }>, input: S.LegRecordInput, ctx: OpsContext) {
  const settings = await freightSettings();
  if (settings.capacityCheck === 'off') return { notes: [] as string[] };
  const truck = await truckFacts(trip.get('vehicleId'), false);
  const trailer = trip.get('trailerId') ? await Trailer.findById(trip.get('trailerId')).select('registrationNumber capacityL capacityKg').lean<Plain>() : null;
  const after = await onBoard(trip._id, extra);
  const tolerance = 1 + settings.capacityTolerancePercent / 100;
  const kgLimits = [truck.capacityT ? truck.capacityT * 1000 : undefined, trailer?.capacityKg ? Number(trailer.capacityKg) : undefined].filter((v): v is number => Boolean(v));
  const kgLimit = kgLimits.length ? Math.min(...kgLimits) : undefined;
  const lLimit = trailer?.capacityL ? Number(trailer.capacityL) : undefined;
  const notes: string[] = [];
  const over: string[] = [];
  const t = (kg: number) => `${Fmt.number(round(kg / 1000, 2), { max: 2 })} t`;
  const hasKg = extra.some((x) => String(x.m.unit).toLowerCase() === 'kg' || String(x.m.unit).toLowerCase() === 't');
  const hasL = extra.some((x) => x.m.ambientL != null || String(x.m.unit).toLowerCase() === 'l');
  if (hasKg) {
    if (kgLimit === undefined) notes.push(`No payload set for ${truck.plate}, so the weight was not checked.`);
    else if (after.kg > kgLimit * tolerance + 0.001) over.push(`${kgLimits.length > 1 && kgLimit === Number(trailer?.capacityKg) ? String(trailer!.registrationNumber) : truck.plate} carries ${t(kgLimit)}; this would put ${t(after.kg)} on board.`);
  }
  if (hasL) {
    if (lLimit === undefined) notes.push(`No tank capacity set for ${trailer ? String(trailer.registrationNumber) : truck.plate}, so the litres were not checked.`);
    else if (after.l > lLimit * tolerance + 0.5) over.push(`${String(trailer!.registrationNumber)} holds ${litres(lLimit)}; this would put ${litres(after.l)} on board.`);
  }
  if (!over.length) return { notes };
  if (settings.capacityCheck === 'warn') return { notes, warnings: over };
  if (!input.override) throw refuse(`${over.join(' ')}${ctx.can('capacity-override', 'create') ? ' Give a reason to record it anyway.' : ''}`);
  if (!ctx.can('capacity-override', 'create')) throw new ForbiddenError(`${over.join(' ')} Your role may not record over capacity.`);
  return { notes, warnings: over, overridden: input.override.reason };
}

/** The papers given at a pickup or drop, as consignment documents. A type left out is the usual one for the step. */
async function documentsFor(input: S.LegRecordInput, leg: Plain, ctx: OpsContext, extra: Array<{ code: string; number?: string; driverDocId?: string }> = []) {
  const out: Plain[] = [];
  const all = [...(input.documents ?? []), ...extra.map((e) => ({ ...e, documentTypeId: undefined }))] as Array<Plain>;
  for (const d of all) {
    if (!d.number && !d.driverDocId && !d.fileId) continue;
    const type = d.documentTypeId ? await activeRecord(ConsignmentDocumentType, d.documentTypeId, 'document type') : await documentTypeByCode(String(d.code ?? (leg.kind === 'pickup' ? 'LOADING_INVOICE' : 'DELIVERY_NOTE')));
    out.push({ _id: oid(), documentTypeId: type?._id, label: type?.name, number: d.number, date: d.date, amount: d.amount, validUntil: d.validUntil, driverDocId: d.driverDocId, fileId: d.fileId, legId: leg._id, at: new Date(), by: ctx.actorId });
  }
  return out;
}

/** Driver-side shortage once the last drop is in (design 3.5.5, today's rule): per goods line, priced by the shortage policy, the product, or the company default. */
async function driverShortage(c: Plain) {
  const results: Plain[] = [];
  for (const line of c.lines as Plain[]) {
    const f = await productFacts(line.productId);
    const { loaded, delivered } = lineTotals(c as never, line._id, f.volumeCorrected);
    if (!loaded) continue;
    const product = f.product;
    const policy = (await ShortagePolicy.findOne({ status: 'active', $or: [{ productId: product._id }, { productGroupId: product.groupId }] }).sort({ productId: -1 }).lean()) as Plain | null;
    const percent = policy
      ? policy.allowanceKind === 'absolute' ? round((Number(policy.allowanceValue) / loaded) * 100, 4) : Number(policy.allowanceValue)
      : Number(product.shortageAllowancePercent ?? (await operationsSettings()).defaultShortageAllowancePercent);
    const figures = shortageLitres(loaded, delivered, percent, f.volumeCorrected ? 0 : f.decimals);
    const price = (policy?.pricePerUnit ?? product.shortagePricePerUnit) as { amountMinor: number; currencyId: unknown } | undefined;
    const share = policy?.bearer === 'company' ? 0 : policy?.bearer === 'shared' ? Number(policy.driverSharePercent ?? 50) / 100 : 1;
    const amountMinor = price ? Math.round(figures.netShortL * price.amountMinor * share) : 0;
    results.push({ unit: f.volumeCorrected ? 'L' : f.unit, ...figures, price, amountMinor, share });
  }
  if (!results.length) return undefined;
  const first = results[0]!;
  const same = results.filter((r) => r.unit === first.unit);
  const sum = (key: string) => round(same.reduce((s, r) => s + Number(r[key] ?? 0), 0), 3);
  const price = first.price as { amountMinor: number; currencyId: unknown } | undefined;
  const amountMinor = results.reduce((s, r) => s + Number(r.amountMinor), 0);
  const baseAmountMinor = price && amountMinor ? (await toBase(amountMinor, price.currencyId)).baseMinor : 0;
  const netShortL = sum('netShortL');
  const pending = netShortL > 0 && baseAmountMinor > 0;
  return {
    unit: first.unit, loaded20L: sum('loaded20L'), delivered20L: sum('delivered20L'), lossL: sum('lossL'), allowancePercent: first.allowancePercent, allowanceL: sum('allowanceL'), netShortL,
    ...(price ? { pricePerL: price, amount: { amountMinor, currencyId: price.currencyId } } : {}),
    baseAmountMinor, status: pending ? 'pending' : 'none',
    ...(pending ? { approval: await routeApproval('shortage_waiver', { amountMinor: baseAmountMinor, currencyId: (await baseCurrency()).id }) } : {}),
  };
}

/**
 * Records one pickup or one drop (design 3.7.3): the trip is on the road; the stage allows it; each goods line is
 * measured the way its product is (20 °C, weighbridge, count); capacity by the company's policy; the truck is at the
 * leg's stop; the leg is done with its papers; status, trip events and price follow; the driver and the office are told.
 */
export async function recordLeg(cid: string, legId: string, input: S.LegRecordInput, ctx: OpsContext, extraDocs: Array<{ code: string; number?: string; driverDocId?: string }> = []): Promise<Plain> {
  need(ctx, 'consignments', 'update');
  const at = new Date();
  const consignment = await loadOr404(Consignment, cid, 'Consignment');
  const leg = (consignment.get('legs') as Plain[]).find((l) => id(l._id) === legId);
  if (!leg) throw new NotFoundError('Pickup or drop not found');
  if (leg.status === 'done') throw conflict(leg.kind === 'pickup' ? 'This pickup is already recorded.' : 'Already delivered.');
  if (leg.status === 'skipped') throw conflict('Nothing is planned here any more.');
  if (['cancelled', 'written_off'].includes(String(consignment.get('status')))) throw conflict('This consignment is finished with.');
  const trip = await tripOf(consignment.get('tripId'));
  if (!trip.get('dispatchedAt')) throw conflict('Dispatch the truck first.');
  if (!trip.get('active')) throw conflict('This trip is closed.');
  const pickup = leg.kind === 'pickup';
  if (!pickup && input.outcome === 'refused') throw refuse("Goods the consignee refused are not a delivery: use \"Can't deliver\" to return, move or write them off.");
  if (!pickup && !(consignment.get('legs') as Plain[]).some((l) => l.kind === 'pickup' && l.status === 'done')) throw conflict('Record the loading first.');
  assertStageAllows(trip.toObject(), pickup ? 'loaded' : 'delivered');
  const lines = consignment.get('lines') as Plain[];
  const cargoKinds: string[] = (await operationsSettings()).cargoKinds;
  const measures: Plain[] = [];
  const extra: Array<{ productId: unknown; m: Plain }> = [];
  for (const given of input.measures) {
    const line = lines.find((l) => id(l._id) === given.lineId);
    if (!line) throw refuse('A measure names a goods line that is not on this consignment.');
    const f = await productFacts(line.productId);
    if (pickup && !cargoKinds.includes(f.kind)) throw refuse(`This company doesn't carry ${CARGO_KIND_NAME[f.kind]}. An owner can change that in Company → Trips.`);
    if (f.volumeCorrected) await fuelChecks(given, pickup ? '' : ' at offloading');
    const quantity = quantityOf(f.kind, given, f.decimals);
    const m = measure({ volumeCorrected: f.volumeCorrected, unit: f.unit }, { qty: quantity, ambientL: given.ambientL ?? (f.volumeCorrected ? quantity : undefined), tempC: given.tempC, density: given.density, certStd20L: given.certStd20L, gross: given.gross, tare: given.tare, ticketNo: given.ticketNo });
    const row: Plain = { lineId: line._id, ...m, pieces: given.pieces, accepted: given.accepted, damaged: given.damaged, shortDelivered: given.shortDelivered, docIds: input.docId ? [new Types.ObjectId(input.docId)] : undefined };
    if (!pickup) {
      // Fuel compares at 20 °C, other cargo in its unit: the running delivered total against what was loaded.
      const { deliveredOverLoadedPercent } = await operationsSettings();
      const totals = lineTotals(consignment.toObject() as never, line._id, f.volumeCorrected);
      const loadedQty = f.volumeCorrected && volume20(m) == null
        ? summedMeasure((consignment.get('legs') as Plain[]).filter((l) => l.kind === 'pickup' && l.status === 'done').flatMap((l) => (l.actual ?? []) as Plain[]).filter((x) => id(x.lineId) === id(line._id)))?.ambientL as number ?? totals.loaded
        : totals.loaded;
      const deliveredQty = totals.delivered + (f.volumeCorrected && volume20(m) == null ? Number(m.ambientL ?? m.qty) : comparable(m, f.volumeCorrected));
      const limit = Number(loadedQty) * (1 + deliveredOverLoadedPercent / 100);
      if (deliveredQty > limit) {
        const at20 = f.volumeCorrected && volume20(m) != null;
        throw refuse(`Delivered ${Fmt.number(Math.round(deliveredQty))}${at20 ? ' L at 20 °C' : ''} is more than loaded (${Fmt.number(Math.round(Number(loadedQty)))}) by over ${deliveredOverLoadedPercent}%. Check the figures.`);
      }
    }
    measures.push(row);
    extra.push({ productId: line.productId, m: m as unknown as Plain });
  }
  const capacity = pickup ? await checkCapacity(trip, extra, input, ctx) : { notes: [] as string[] };
  const stops = trip.get('stops') as Array<Plain & { _id: unknown; kind: string; legKm: number }>;
  const index = stops.findIndex((s) => id(s._id) === id(leg.stopId));
  if (index >= 0) await arriveAt(trip, index, at, ctx, 'office');
  const step = pickup ? 'loading' : 'delivery';
  consignment.set('custom', await stepCustom('consignments', step, input.custom, (consignment.toObject() as Plain).custom as Plain | undefined));
  const docs = await documentsFor(input, leg, ctx, extraDocs);
  Object.assign(leg, {
    status: 'done', actual: measures, recordedAt: at, recordedBy: ctx.actorId, note: input.note ?? leg.note,
    ...(pickup ? {} : { outcome: input.outcome ?? (measures.some((m) => m.accepted != null && Number(m.accepted) < Number(m.qty)) ? 'partial' : 'delivered'), pod: { ...((leg.pod ?? {}) as Plain), ...(input.pod ?? {}), docIds: input.docId ? [new Types.ObjectId(input.docId)] : (leg.pod as Plain | undefined)?.docIds } }),
  });
  consignment.markModified('legs');
  consignment.set('documents', [...(consignment.get('documents') as Plain[]), ...docs]);
  if (input.sealNos?.length) consignment.set('references', { ...((consignment.toObject() as Plain).references as Plain ?? {}), sealNos: input.sealNos });
  const plain = consignment.toObject() as Plain;
  if (pickup && !consignment.get('loadedAt')) consignment.set('loadedAt', at);
  const allDropped = drops(plain as never).every((l) => l.status === 'done');
  let shortage: Plain | undefined;
  if (!pickup && allDropped) {
    consignment.set('deliveredAt', at);
    shortage = await driverShortage(plain);
    if (shortage) consignment.set('shortage', shortage);
  }
  consignment.set({ status: deriveStatus(consignment.toObject() as never, trip.toObject() as never), leadKm: leadKm(trip.toObject().stops as never, consignment.toObject() as never), updatedBy: ctx.actorId });
  await save(consignment, pickup ? 'This pickup is already recorded.' : 'Already delivered.');
  // The trip's last drop: the stops that follow at the same place (the end, at the depot) are reached too.
  const tripConsignments = (await Consignment.find({ tripId: trip._id }).lean()) as unknown as ConsignmentP[];
  if (!pickup && index >= 0 && working(tripConsignments, trip._id).every((c) => drops(c).every((l) => l.status === 'done') || isFinished(c))) {
    const cum = cumulativeKm(stops as never);
    for (let i = index + 1; i < stops.length; i += 1) if (cum[i]! <= cum[index]! + 0.01) await arriveAt(trip, i, at, ctx, 'office');
  }
  const tracking = trip.get('tracking');
  if (tracking && index >= 0) trip.set('tracking.km', Math.max(Number(tracking.km ?? 0), cumulativeKm(stops as never)[index]!));
  for (const warning of capacity.warnings ?? []) await log(ctx, at, `Over capacity${capacity.overridden ? `, recorded by ${ctx.name}: ${capacity.overridden}` : ''}: ${warning}`, { tripId: trip._id });
  trip.markModified('stops');
  trip.set('updatedBy', ctx.actorId);
  await save(trip);
  const events = await afterLegs(trip._id, at, ctx);
  if (input.docId) {
    await markRecorded(input.docId, trip._id, String(consignment.get('number')), `${pickup ? 'Loading' : 'Delivery'} confirmed · ${consignment.get('number')}`);
    await DriverDocument.updateOne({ _id: input.docId }, { $set: { consignmentId: consignment._id, legId: leg._id }, $inc: { version: 1 } });
  }
  await reprice(cid, ctx);
  const fresh = (await Consignment.findById(cid).lean()) as Plain;
  const freshTrip = (await Trip.findById(trip._id).lean()) as Plain;
  if (pickup) await afterPickup(freshTrip, fresh, leg, measures, docs, events, at, ctx);
  else await afterDrop(freshTrip, fresh, leg, measures, input, shortage, events, at, ctx);
  const out = presentConsignment(fresh, ctx.can);
  return { ...out, checks: { capacity: { notes: capacity.notes, warnings: capacity.warnings ?? [] } } };
}

/** "38,000 L diesel · 37,650 L at 20 °C", or "28 t copper cathodes", for the messages. */
async function quantityText(c: Plain, measures: Plain[]) {
  const parts: string[] = [];
  for (const m of measures) {
    const line = (c.lines as Plain[]).find((l) => id(l._id) === id(m.lineId))!;
    const f = await productFacts(line.productId);
    const name = String(f.product.name).toLowerCase();
    parts.push(f.volumeCorrected ? `${litres(Number(m.qty))} ${name} · ${litres(volume20(m as unknown as Measure) ?? Number(m.qty))} at 20 °C` : `${amountOf(Number(m.qty), String(m.unit))} ${name}`);
  }
  return parts.join('; ');
}

/**
 * Where the truck goes next and why (#102): the earliest stop with a pickup or drop still planned, across every
 * consignment on the trip, so the driver isn't sent past a stop with work left.
 */
async function nextOnTrip(trip: Plain): Promise<string | undefined> {
  const stops = (trip.stops ?? []) as Plain[];
  const index = (stopId: unknown) => stops.findIndex((s) => id(s._id) === id(stopId));
  const list = await Consignment.find({ tripId: trip._id, status: { $ne: 'cancelled' } }).select('number legs').lean<Plain[]>();
  const open = list.flatMap((c) => ((c.legs ?? []) as Plain[]).filter((l) => l.status === 'planned' && l.stopId).map((l) => ({ c, l, i: index(l.stopId) }))).filter((x) => x.i >= 0);
  if (!open.length) return undefined;
  const first = Math.min(...open.map((x) => x.i));
  const here = open.filter((x) => x.i === first);
  const numbers = (kind: string) => [...new Set(here.filter((x) => x.l.kind === kind).map((x) => String(x.c.number)))].join(', ');
  const work = [numbers('drop') && `drop ${numbers('drop')}`, numbers('pickup') && `load ${numbers('pickup')}`].filter(Boolean).join(' and ');
  return `${await placeName(stops[first]!.placeId)} to ${work}`;
}

async function afterPickup(trip: Plain, c: Plain, leg: Plain, measures: Plain[], docs: Plain[], events: string[], at: Date, ctx: OpsContext) {
  const qty = await quantityText(c, measures);
  const invoice = docs.find((d) => d.number)?.number as string | undefined;
  const nextDrop = drops(c as never).find((l) => l.status === 'planned');
  // The next stop on the whole trip, which may be another pickup, not this consignment's drop (#102).
  const to = (await nextOnTrip(trip)) ?? (nextDrop?.placeId ? await placeName(nextDrop.placeId) : 'the drop the office will confirm');
  if (trip.driverId) {
    await post(driverThread(trip.driverId), at, {
      title: 'Loading confirmed', text: `${qty}. Next: ${to}. Drive safely.`, rows: [['Consignment', String(c.number)], ...(invoice ? [['Invoice', invoice] as [string, string]] : [])],
      wa: { template: 'loading_confirmed', values: [String(trip.number), qty, to] },
    }, ctx);
  }
  await log(ctx, at, `Loaded ${qty} · ${c.number}`, { tripId: trip._id });
  const variables = { 'place.name': await placeName(leg.placeId), 'document.number': invoice ?? '', 'consignment.number': String(c.number), ...customValues('consignment', c.custom) };
  if (events.includes('loaded')) await announce('trip.loaded', trip, ctx, { variables, ref: { kind: 'consignments', id: c._id } });
  await announce('consignment.loaded', trip, ctx, { variables, ref: { kind: 'consignments', id: c._id } });
}

async function afterDrop(trip: Plain, c: Plain, leg: Plain, measures: Plain[], input: S.LegRecordInput, shortage: Plain | undefined, events: string[], at: Date, ctx: OpsContext) {
  const pod = String(input.pod?.number ?? '');
  const cid = String(c._id);
  const first = measures[0]!;
  const line = (c.lines as Plain[]).find((l) => id(l._id) === id(first.lineId))!;
  const f = await productFacts(line.productId);
  if (trip.driverId) {
    const delivered = shortage ? `${amountOf(Number(shortage.delivered20L), String(shortage.unit))}${f.volumeCorrected ? ' at 20 °C' : ''}` : `${amountOf(Number(first.qty), String(first.unit))} delivered`;
    const text = shortage
      ? Number(shortage.netShortL) > 0
        ? `${delivered}. ${amountOf(Number(shortage.lossL), String(shortage.unit))} less than loaded${shortage.status === 'pending' ? `; finance will review the ${amountOf(Number(shortage.netShortL), String(shortage.unit))} above the allowance` : ''}.`
        : `${delivered}, within the allowance. Well done.`
      : `${delivered}.`;
    // With work left on the trip, the driver is told where to drive on to (#102).
    const next = await nextOnTrip(trip);
    const told = next ? `${text} Next: ${next}.` : text;
    await post(driverThread(trip.driverId), at, { title: 'Delivery confirmed', text: told, rows: [['Delivery note', pod]], wa: { template: 'delivery_confirmed', values: [String(trip.number), `${text.replace(/\.$/, '')}, delivery note ${pod}${next ? `. Next: ${next}` : ''}`] } }, ctx);
  }
  if (shortage?.status === 'pending') {
    const charge = formatMoney(Number(shortage.baseAmountMinor), await baseCurrency());
    const price = shortage.pricePerL ? formatMoney((shortage.pricePerL as Plain).amountMinor as number, await currencyInfo((shortage.pricePerL as Plain).currencyId)) : '—';
    await post(queue('shortage-decisions'), at, {
      title: `${f.volumeCorrected ? 'Fuel shortage' : 'Shortage'} on ${trip.number}`,
      text: `${amountOf(Number(shortage.netShortL), String(shortage.unit))} beyond the ${shortage.allowancePercent}% allowance.`,
      rows: [
        [f.volumeCorrected ? 'Loaded at 20 °C' : 'Loaded', amountOf(Number(shortage.loaded20L), String(shortage.unit))], [f.volumeCorrected ? 'Delivered at 20 °C' : 'Delivered', amountOf(Number(shortage.delivered20L), String(shortage.unit))],
        ['Allowance', amountOf(Number(shortage.allowanceL), String(shortage.unit))], ['Charge', `${charge} (${price}/${shortage.unit})`], ['Driver', (await driverName(trip.driverId)) || '—'],
      ],
      buttons: [
        { label: `Charge ${charge}`, tone: 'primary', action: { type: 'shortage.decide', consignmentId: cid, charge: true, via: 'whatsapp' } },
        { label: 'Waive', action: { type: 'shortage.decide', consignmentId: cid, charge: false, note: 'Waived on WhatsApp', via: 'whatsapp' } },
        { label: 'Open trip', nav: { tripId: String(trip._id), view: 'offloading' } },
      ],
      refId: `${cid}-shortage`,
    }, ctx);
  } else if (shortage && Number(shortage.netShortL) > 0) {
    await post(queue('shortage-decisions'), at, {
      title: `Shortage on ${trip.number}`,
      text: `${amountOf(Number(shortage.netShortL), String(shortage.unit))} beyond the ${shortage.allowancePercent}% allowance. This product has no shortage price, so nothing was charged. Set one under Products to charge or waive shortages.`,
      refId: `${cid}-shortage`,
    }, ctx);
  }
  await log(ctx, at, `Delivered · ${pod || c.number}${shortage ? ` · ${amountOf(Number(shortage.lossL), String(shortage.unit))} transit loss` : ''}`, { tripId: trip._id });
  const variables = { 'place.name': await placeName(leg.placeId), 'document.number': pod, 'consignment.number': String(c.number), ...customValues('consignment', c.custom) };
  if (events.includes('delivered')) await announce('trip.delivered', trip, ctx, { variables, ref: { kind: 'consignments', id: c._id } });
  await announce('consignment.delivered', trip, ctx, { variables, ref: { kind: 'consignments', id: c._id } });
  if (pod || (input.pod as Plain | undefined)?.receivedBy || input.docId) await announce('consignment.pod_received', trip, ctx, { variables, ref: { kind: 'consignments', id: c._id } });
}

/** Several consignments' pickups or drops at one stop, in one action (40 parcels dropped at one door). Each is recorded on its own; the results say which went in. */
export async function recordAtStop(tripId: string, stopId: string, input: S.StopRecordInput, ctx: OpsContext) {
  need(ctx, 'consignments', 'update');
  const trip = await tripOf(tripId);
  if (!(trip.get('stops') as Plain[]).some((s) => id(s._id) === stopId)) throw new NotFoundError('Stop not found');
  const results: Plain[] = [];
  for (const { consignmentId, legId, ...record } of input.records) {
    const c = await Consignment.findOne({ _id: consignmentId, tripId: trip._id }).select('legs number').lean<Plain>();
    const leg = (c?.legs as Plain[] | undefined)?.find((l) => id(l._id) === legId);
    if (!c || !leg) { results.push({ consignmentId, legId, ok: false, error: 'Not on this trip.' }); continue; }
    if (id(leg.stopId) !== stopId) { results.push({ consignmentId, legId, number: c.number, ok: false, error: `${c.number} is not loaded or dropped at this stop.` }); continue; }
    try {
      const saved = await recordLeg(consignmentId, legId, record, ctx) as Plain;
      results.push({ consignmentId, legId, number: c.number, ok: true, status: saved.status });
    } catch (err) {
      results.push({ consignmentId, legId, number: c.number, ok: false, error: (err as Error).message });
    }
  }
  return { recorded: results.filter((r) => r.ok).length, results };
}

/* ---------- Papers ---------- */

export async function attachDocument(cid: string, input: S.AttachDocumentInput, ctx: OpsContext) {
  need(ctx, 'consignments', 'update');
  const consignment = await loadOr404(Consignment, cid, 'Consignment');
  const leg = input.legId ? (consignment.get('legs') as Plain[]).find((l) => id(l._id) === input.legId) : undefined;
  if (input.legId && !leg) throw new NotFoundError('Pickup or drop not found');
  if (input.driverDocId) {
    const doc = await DriverDocument.findById(input.driverDocId).select('tripId').lean<Plain>();
    if (!doc || id(doc.tripId) !== id(consignment.get('tripId'))) throw refuse('That photo belongs to another trip.');
  }
  const [doc] = await documentsFor({ measures: [], documents: [input] } as never, leg ?? { kind: 'pickup' }, ctx);
  if (!doc) throw refuse('Enter the number, or attach the photo.');
  if (!leg) doc.legId = undefined;
  consignment.get('documents').push(doc);
  consignment.set('updatedBy', ctx.actorId);
  await save(consignment);
  if (input.driverDocId) await DriverDocument.updateOne({ _id: input.driverDocId }, { $set: { consignmentId: consignment._id, legId: leg?._id, documentTypeId: doc.documentTypeId }, $inc: { version: 1 } });
  await log(ctx, new Date(), `${doc.label ?? 'Document'} ${doc.number ?? ''} added to ${consignment.get('number')}`.replace(/\s+/g, ' '), { tripId: consignment.get('tripId'), entity: 'consignments', entityId: consignment._id });
  await afterLegs(consignment.get('tripId'), new Date(), ctx);
  return getConsignment(cid, ctx);
}

export async function detachDocument(cid: string, docId: string, ctx: OpsContext) {
  need(ctx, 'consignments', 'update');
  const consignment = await loadOr404(Consignment, cid, 'Consignment');
  const docs = consignment.get('documents') as Plain[];
  const doc = docs.find((d) => id(d._id) === docId);
  if (!doc) throw new NotFoundError('Document not found');
  consignment.set('documents', docs.filter((d) => id(d._id) !== docId));
  await save(consignment);
  if (doc.driverDocId) await DriverDocument.updateOne({ _id: doc.driverDocId }, { $unset: { consignmentId: 1, legId: 1 }, $inc: { version: 1 } });
  await log(ctx, new Date(), `${doc.label ?? 'Document'} ${doc.number ?? ''} taken off ${consignment.get('number')}`.replace(/\s+/g, ' '), { tripId: consignment.get('tripId'), entity: 'consignments', entityId: consignment._id });
  return getConsignment(cid, ctx);
}

/** Say what a driver's photo is and which consignment and pickup or drop it belongs to: "Move to another consignment", "Change what this is". */
export async function fileDriverDocument(docId: string, input: S.FileDocumentInput, ctx: OpsContext) {
  need(ctx, 'driver-documents', 'update');
  const doc = await loadOr404(DriverDocument, docId, 'Document');
  const set: Plain = {};
  if (input.documentTypeId) {
    const type = await activeRecord(ConsignmentDocumentType, input.documentTypeId, 'document type');
    set.documentTypeId = type._id;
    if (doc.get('status') === 'new') set.kind = type.driverKind === 'pod' || type.driverKind === 'delivery' ? 'delivery' : type.driverKind === 'loading' ? 'loading' : type.driverKind ?? 'other';
  }
  if (input.consignmentId) {
    const c = await Consignment.findOne({ _id: input.consignmentId, tripId: doc.get('tripId') }).select('legs number').lean<Plain>();
    if (!c) throw refuse('That consignment is not on the trip this photo was sent for.');
    if (input.legId && !(c.legs as Plain[]).some((l) => id(l._id) === input.legId)) throw refuse('That pickup or drop is not on the consignment.');
    set.consignmentId = c._id;
    set.legId = input.legId;
  }
  doc.set({ ...set, question: undefined, updatedBy: ctx.actorId });
  await save(doc);
  await log(ctx, new Date(), "Filed the driver's photo", { tripId: doc.get('tripId'), entity: 'driver-documents', entityId: doc._id });
  return present(doc.toObject());
}

/* ---------- One load per trip: the requests of before, for one release (design 3.10) ---------- */

/**
 * Today's loading body: a trip's one load. It records the pickup of the consignment planned at the trip's loading
 * point when there is one (made with the trip), or makes the consignment and records it. A trip already loaded with
 * nothing more planned refuses, as before: add another consignment from the trip's Consignments tab.
 */
export async function recordLoading(input: S.LoadingInput, ctx: OpsContext) {
  need(ctx, 'consignments', 'create');
  const trip = await tripOf(input.tripId);
  if (!trip.get('dispatchedAt')) throw conflict('Dispatch the truck first.');
  if (!trip.get('active')) throw conflict('This trip is closed.');
  const onTrip = await Consignment.find({ tripId: trip._id, status: { $nin: ['cancelled', 'draft'] } }).sort({ bookedAt: 1 }).lean() as Plain[];
  const open = onTrip.map((c) => ({ c, leg: (c.legs as Plain[]).find((l) => l.kind === 'pickup' && l.status === 'planned') })).filter((x) => x.leg);
  const match = open.find(({ c }) => (c.lines as Plain[]).some((l) => id(l.productId) === input.productId));
  if (!match && onTrip.some((c) => isLoaded(c as never))) throw conflict('This truck is already loaded.');
  assertStageAllows(trip.toObject(), 'loaded');
  let consignment = match?.c;
  let leg = match?.leg;
  if (!consignment) {
    const blank = (v?: string) => (v && v.trim() && v.trim() !== '—' ? v.trim() : undefined);
    consignment = await createOnTrip(trip, {
      lines: [{ productId: input.productId, plannedQty: trip.get('plannedQty') ?? undefined }],
      ...(blank(input.consignor) ? { consignor: { name: blank(input.consignor)! } } : {}),
      ...(blank(input.consignee) ? { consignee: { name: blank(input.consignee)! } } : {}),
    }, { ...ctx, can: (r, a) => (r === 'consignments' && a === 'create') || ctx.can(r, a) });
    leg = (consignment.legs as Plain[]).find((l) => l.kind === 'pickup');
  } else if (input.consignor && !consignment.consignor && !consignment.consignorPartyId) {
    await Consignment.updateOne({ _id: consignment._id }, { $set: { consignor: { name: input.consignor } }, $inc: { version: 1 } });
  }
  const line = (consignment.lines as Plain[]).find((l) => id(l.productId) === input.productId) ?? (consignment.lines as Plain[])[0]!;
  const { tripId: _t, productId: _p, invoiceNo, consignor: _c, consignee: _e, docId, custom, ...m } = input;
  if (!match) {
    // Made for this load: if the load is refused, the consignment goes too, as if nothing was sent.
    try {
      return await recordLeg(String(consignment._id), String(leg!._id), { measures: [{ lineId: String(line._id), ...m }], docId, custom }, { ...ctx, can: (r, a) => (r === 'consignments' && a === 'update') || ctx.can(r, a) }, [{ code: 'LOADING_INVOICE', number: invoiceNo, driverDocId: docId }]);
    } catch (err) {
      await Consignment.deleteOne({ _id: consignment._id, 'legs.status': { $ne: 'done' } });
      throw err;
    }
  }
  return recordLeg(String(consignment._id), String(leg!._id), { measures: [{ lineId: String(line._id), ...m }], docId, custom }, { ...ctx, can: (r, a) => (r === 'consignments' && a === 'update') || ctx.can(r, a) }, [{ code: 'LOADING_INVOICE', number: invoiceNo, driverDocId: docId }]);
}

/** Today's delivery body: records the consignment's next drop (its only one, for a one-load trip). */
export async function recordDelivery(cid: string, input: S.DeliveryInput, ctx: OpsContext) {
  need(ctx, 'consignments', 'update');
  const consignment = await loadOr404(Consignment, cid, 'Consignment');
  const legs = consignment.get('legs') as Plain[];
  const leg = legs.find((l) => l.kind === 'drop' && l.status === 'planned' && l.stopId) ?? legs.find((l) => l.kind === 'drop' && l.status === 'planned');
  if (!leg) throw conflict('Already delivered.');
  const line = (consignment.get('lines') as Plain[])[0]!;
  const { podNo, docId, custom, ...m } = input;
  return recordLeg(cid, String(leg._id), { measures: [{ lineId: String(line._id), ...m }], docId, custom, pod: { number: podNo } }, ctx, [{ code: 'DELIVERY_NOTE', number: podNo, driverDocId: docId }]);
}

/* ---------- For other modules ---------- */

/** A trip's consignments as the GPS exchange needs them (design 3.13), so that code never reads the model. */
export async function consignmentsForExchange(tripId: unknown) {
  const rows = await Consignment.find({ tripId, status: { $nin: ['cancelled', 'draft'] } }).lean() as Plain[];
  const out = [];
  for (const c of rows) {
    const line = (c.lines as Plain[])[0]!;
    const product = await Product.findById(line.productId).select('name').lean();
    const invoice = (c.documents as Plain[]).find((d) => d.number && (c.legs as Plain[]).some((l) => l.kind === 'pickup' && id(l._id) === id(d.legId)));
    out.push({
      number: c.number, lrNumber: (c.references as Plain | undefined)?.lrNo ?? c.number, invoiceNumber: invoice?.number, product: product?.name, quantity: line.plannedQty, unit: line.unit,
      loadingStopRefs: pickups(c as never).map((l) => id(l.stopId)).filter(Boolean), offloadingStopRefs: drops(c as never).map((l) => id(l.stopId)).filter(Boolean),
    });
  }
  return out;
}

/** Re-attaches a trip's consignments after its stops were replaced before dispatch (the plan changed). */
export async function reattachAll(trip: Doc, ctx: OpsContext) {
  const consignments = await Consignment.find({ tripId: trip._id, status: { $nin: ['cancelled', 'draft'] } });
  const stops = (trip.toObject() as Plain).stops as StopP[];
  for (const c of consignments) {
    for (const leg of c.get('legs') as Plain[]) if (leg.status === 'planned' && leg.stopId && !stops.some((s) => id(s._id) === id(leg.stopId))) leg.stopId = undefined;
    c.markModified('legs');
    await attach(trip, c, ctx, consignments.filter((o) => o !== c).map((o) => o.toObject()) as Plain[]);
    await save(c);
  }
}
