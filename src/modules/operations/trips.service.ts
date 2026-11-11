import { Types, type HydratedDocument } from 'mongoose';
import * as Fmt from '../../core/format/regional.js';
import { env } from '../../config/env.js';
import { ForbiddenError, NotFoundError } from '../../core/errors/index.js';
import type { Plain } from '../../core/masters/types.js';
import { isAreaOn } from '../company/areas.js';
import { WorkOrder } from '../maintenance/models/maintenance.model.js';
import { Branch } from '../organisation/models/branch.model.js';
import { Product } from '../cargo/models/product.model.js';
import { Driver } from '../drivers/models/driver.model.js';
import { Trailer } from '../fleet/models/trailer.model.js';
import { Vehicle } from '../fleet/models/vehicle.model.js';
import { VehicleModel } from '../fleet/models/vehicleModel.model.js';
import { BorderPost } from '../geography/models/borderPost.model.js';
import { Place } from '../geography/models/place.model.js';
import { Route } from '../geography/models/route.model.js';
import { Party } from '../parties/models/party.model.js';
import { FuelNorm } from '../trips/models/fuel.model.js';
import { TripBudget } from '../trips/models/tripBudget.model.js';
import {
  cumulativeKm, fuelEstimate, haversineKm, round, stampArrival, tripKm, validateStops,
  type StopLeg, type StopPlan,
} from './calc.js';
import { waitingOn, type Approval } from './approvals.js';
import { stepCustom } from './placements.js';
import { issueButtons, requestAmount, requestButtons } from './funding.service.js';
import { assertStageAllows, currentStage, recordEvent, stageSnapshot, tripTypeFor } from './stages.js';
import { carriedIn, driverBalance } from './ledger.js';
import { announce } from './notices.js';
import { Consignment } from './models/cargo.model.js';
import { tripGate } from './gate.js';
import { isFinished, isLoaded, working } from './legs.js';
import { freightSettings } from '../freight/settings.js';
import { cancelPlanned, createOnTrip, prepareConsignment, reattachAll } from './consignments.service.js';
import { FundRequest, OPEN_REQUEST, VehicleState } from './models/funding.model.js';
import { Expense, Nomination } from './models/money.model.js';
import { TO_SETTLE, Trip, type ArrivalSource } from './models/trip.model.js';
import {
  activeDriver, activeRecord, baseCurrency, conflict, customerParty, driverThread, firstName, formatMoney, litres, log,
  need, nextNumber, post, present, queue, refuse, resolve, save, toBase, type OpsContext,
} from './support.js';
import type * as S from './operations.schema.js';
import { operationsSettings } from './settings.js';

/* ---------- Names for messages ---------- */

export const placeName = async (id: unknown) => (id ? String((await Place.findById(id).select('name').lean())?.name ?? '—') : '—');
export const plateOf = async (id: unknown) => (id ? String((await Vehicle.findById(id).select('registrationNumber').lean())?.registrationNumber ?? '') : '');
export const trailerPlate = async (id: unknown) => (id ? String((await Trailer.findById(id).select('registrationNumber').lean())?.registrationNumber ?? '') : '');
export const driverName = async (id: unknown) => (id ? String((await Driver.findById(id).select('name').lean())?.name ?? '') : '');
export const partyName = async (id: unknown) => (id ? String((await Party.findById(id).select('name').lean())?.name ?? '') : '');

/** First loading to last drop, naming the work stops between (#102), as the screens do. */
export async function routeLabel(trip: { stops: Array<{ kind: string; placeId: unknown }> }) {
  const work = trip.stops.filter((s) => s.kind === 'load' || s.kind === 'offload');
  const first = work.find((s) => s.kind === 'load') ?? work[0];
  const last = [...work].reverse().find((s) => s.kind === 'offload') ?? work.at(-1);
  const ends = new Set([String(first?.placeId), String(last?.placeId)]);
  const between = [...new Set(work.slice(first ? work.indexOf(first) + 1 : 0, last ? work.lastIndexOf(last) : undefined).map((s) => String(s.placeId)))].filter((p) => !ends.has(p));
  const via = between.length === 0 ? '' : between.length <= 2 ? ` via ${(await Promise.all(between.map((p) => placeName(p)))).join(' and ')}` : ` via ${between.length} stops`;
  return `${await placeName(first?.placeId)} to ${await placeName(last?.placeId)}${via}`;
}

/* ---------- Trucks ---------- */

export interface Truck {
  vehicle: Plain;
  plate: string;
  tankL?: number;
  kmPerLLoaded?: number;
  kmPerLEmpty?: number;
  reservePercent: number;
  capacityT?: number;
  placeId?: string;
  fuelL: number;
}

/** A truck with its consumption (vehicle, then model, then fuel norm), tank, and where it is now. */
export async function truckFacts(vehicleId: unknown, mustBeActive = true): Promise<Truck> {
  const vehicle = mustBeActive ? await activeRecord(Vehicle, vehicleId, 'truck') : (await Vehicle.findById(vehicleId).lean()) as Plain;
  if (!vehicle) throw refuse('The truck was not found.');
  const model = vehicle.modelId ? await VehicleModel.findById(vehicle.modelId).lean() : null;
  const norms = await FuelNorm.find({ status: 'active', $or: [{ vehicleModelId: vehicle.modelId ?? null }, { vehicleTypeId: vehicle.vehicleTypeId }] }).lean();
  const norm = norms.find((n) => vehicle.modelId && String(n.vehicleModelId) === String(vehicle.modelId)) ?? norms.find((n) => String(n.vehicleTypeId) === String(vehicle.vehicleTypeId));
  const state = await VehicleState.findOne({ vehicleId: vehicle._id }).lean();
  let placeId = state?.placeId ? String(state.placeId) : undefined;
  if (!placeId && vehicle.homeBranchId) {
    const branch = await Branch.findById(vehicle.homeBranchId).select('placeId').lean();
    if (branch?.placeId) placeId = String(branch.placeId);
  }
  const num = (...values: unknown[]) => values.map((v) => (typeof v === 'number' && v > 0 ? v : undefined)).find((v) => v !== undefined);
  return {
    vehicle,
    plate: String(vehicle.registrationNumber),
    tankL: num(vehicle.tankCapacityL, model?.tankCapacityL),
    kmPerLLoaded: num(vehicle.kmPerLLoaded, model?.kmPerLLoaded, norm?.kmPerLLoaded),
    kmPerLEmpty: num(vehicle.kmPerLEmpty, model?.kmPerLEmpty, norm?.kmPerLEmpty),
    reservePercent: typeof norm?.reservePercent === 'number' ? Number(norm.reservePercent) : (await operationsSettings()).defaultFuelReservePercent,
    capacityT: num(vehicle.payloadKg) ? Number(vehicle.payloadKg) / 1000 : undefined,
    placeId,
    fuelL: Number(state?.fuelL ?? 0),
  };
}

export async function setVehicleState(vehicleId: unknown, change: { placeId?: unknown; fuelL?: number }, actorId?: string) {
  const set: Plain = { updatedBy: actorId };
  if (change.placeId !== undefined) set.placeId = change.placeId;
  if (change.fuelL !== undefined) set.fuelL = round(change.fuelL, 0);
  await VehicleState.updateOne({ vehicleId }, { $set: set, $inc: { version: 1 } }, { upsert: true });
}

export async function listVehicleStates() {
  return (await VehicleState.find().lean()).map(present);
}

/** Operations corrects where a truck is or how much fuel it has. Not while it is on a trip. */
export async function correctVehicleState(vehicleId: string, input: S.VehicleStateInput, ctx: OpsContext) {
  need(ctx, 'vehicle-states', 'update');
  const truck = await truckFacts(vehicleId);
  if (await Trip.exists({ vehicleId, active: true, dispatchedAt: { $exists: true } })) throw conflict(`${truck.plate} is on the road. Its place and fuel follow the trip.`);
  if (input.placeId) await activeRecord(Place, input.placeId, 'place');
  if (input.fuelL !== undefined && truck.tankL && input.fuelL > truck.tankL) throw refuse(`The tank holds ${litres(truck.tankL)}.`);
  await setVehicleState(vehicleId, input, ctx.actorId);
  await log(ctx, new Date(), `${truck.plate}: ${[input.placeId ? `at ${await placeName(input.placeId)}` : '', input.fuelL !== undefined ? `${litres(input.fuelL)} in the tank` : ''].filter(Boolean).join(', ')}`, { entity: 'vehicles', entityId: vehicleId });
  return present(await VehicleState.findOne({ vehicleId }).lean());
}

/* ---------- Stops and budgets ---------- */

/**
 * Road kilometres from route masters where a route has the leg; otherwise straight-line × the company's
 * road distance factor. Driving hours use its average speed; border posts add their usual wait.
 */
export async function buildStops(plan: StopPlan[], options: { tripsWithoutCargo?: boolean } = {}): Promise<Array<StopLeg & { _id: Types.ObjectId }>> {
  const problem = validateStops(plan, options);
  if (problem) throw refuse(problem);
  const legs = await legFigures(plan);
  return plan.map((stop, index) => ({ _id: new Types.ObjectId(), placeId: stop.placeId, kind: stop.kind, ...legs[index]! }));
}

/** Each stop's leg: road kilometres from the stop before it and the hours to drive them, waiting at a border included. */
export async function legFigures(plan: Array<{ placeId: unknown }>): Promise<Array<{ legKm: number; legHours: number }>> {
  const { roadDistanceFactor, averageSpeedKmh } = await operationsSettings();
  const ids = [...new Set(plan.map((s) => String(s.placeId)))];
  const places = await Place.find({ _id: { $in: ids } }).select('name type location status').lean();
  const byId = new Map(places.map((p) => [String(p._id), p]));
  for (const id of ids) if (byId.get(id)?.status !== 'active') throw refuse('A stop uses a place that was not found or is archived.');
  const known = new Map<string, number>();
  for (const route of await Route.find({ status: 'active', 'stops.placeId': { $in: ids } }).select('stops').lean()) {
    const stops = route.stops as Array<{ placeId: unknown; legKm: number }>;
    for (let i = 1; i < stops.length; i += 1) {
      const a = String(stops[i - 1]!.placeId), b = String(stops[i]!.placeId);
      if (!known.has(`${a}-${b}`)) known.set(`${a}-${b}`, stops[i]!.legKm);
      if (!known.has(`${b}-${a}`)) known.set(`${b}-${a}`, stops[i]!.legKm);
    }
  }
  const waits = new Map((await BorderPost.find({ placeId: { $in: ids }, status: 'active' }).select('placeId typicalWaitHours').lean()).map((b) => [String(b.placeId), Number(b.typicalWaitHours ?? 0)]));
  return plan.map((stop, index) => {
    const prev = plan[index - 1];
    const here = String(stop.placeId);
    let km = 0;
    if (prev && String(prev.placeId) !== here) {
      const a = byId.get(String(prev.placeId))?.location as { lat: number; lng: number } | undefined;
      const b = byId.get(here)?.location as { lat: number; lng: number } | undefined;
      km = known.get(`${String(prev.placeId)}-${here}`) ?? (a && b ? Math.round(haversineKm(a, b) * roadDistanceFactor) : 0);
    }
    const wait = byId.get(here)?.type === 'border' ? waits.get(here) ?? 0 : 0;
    return { legKm: km, legHours: round(km / averageSpeedKmh + (index ? wait : 0), 1) };
  });
}

/**
 * A trip's stops after a stop was added, moved or removed (#135): the legs the truck has already driven keep their
 * figures; every leg after the last stop it reached is worked out again. Ids, arrivals and everything else are kept.
 */
export async function refigureStops<T extends { placeId: unknown; legKm: number; legHours?: number; arrivedAt?: Date }>(stops: T[]): Promise<T[]> {
  const reached = stops.reduce((found, s, i) => (s.arrivedAt ? i : found), -1);
  const legs = await legFigures(stops);
  return stops.map((stop, i) => (i <= reached ? stop : Object.assign(stop, legs[i]!)));
}

/** A route's stops, starting where the truck is now. */
export function stopsFromTruck(route: StopPlan[], placeId?: string): StopPlan[] {
  if (!route.length || !placeId || route[0]!.placeId === placeId) return route;
  return [{ placeId, kind: 'start' }, ...route.slice(1)];
}

/** Fuel and cash budgets: the route's own figures, then its trip budget, then an estimate from distance. */
async function budgets(trip: Plain, truck: Truck) {
  const base = await baseCurrency();
  const route = trip.routeId ? await Route.findById(trip.routeId).lean() : null;
  const budget = route ? await TripBudget.findOne({ routeId: route._id, status: 'active', $or: [{ vehicleTypeId: truck.vehicle.vehicleTypeId }, { vehicleTypeId: { $exists: false } }] }).sort({ vehicleTypeId: -1 }).lean() : null;
  const stops = trip.stops as StopLeg[];
  const estimate = stops.length && truck.kmPerLLoaded && truck.kmPerLEmpty ? fuelEstimate(stops, truck.kmPerLLoaded, truck.kmPerLEmpty, truck.reservePercent) : 0;
  const fuelBudgetL = Number(route?.fuelBudgetL ?? budget?.fuelL ?? estimate);
  let cashMinor = 0;
  const routeCash = route?.cashBudget as { amountMinor: number; currencyId: unknown } | undefined;
  if (routeCash) cashMinor = (await toBase(routeCash.amountMinor, routeCash.currencyId)).baseMinor;
  else if (budget?.totalCashMinor) cashMinor = (await toBase(Number(budget.totalCashMinor), budget.currencyId)).baseMinor;
  return { fuelBudgetL, cashBudget: { amountMinor: cashMinor, currencyId: base.id } };
}

/* ---------- Reading ---------- */

export const activeTrip = (trip: Plain) => !trip.endedAt && !trip.cancelledAt;

export function tripState(trip: Plain) {
  if (trip.cancelledAt) return 'cancelled';
  if (trip.settlementId) return 'settled';
  if (trip.endedAt) return 'ended';
  if (trip.dispatchedAt) return 'on_road';
  return 'planned';
}

export const presentTrip = (doc: Plain): Plain => {
  const out = present(doc);
  // Stops carry `id` like every other record (they are subdocuments with their own _id).
  out.stops = ((out.stops ?? []) as Plain[]).map(({ _id, ...stop }) => ({ id: _id, ...stop }));
  return { ...out, state: tripState(doc), totalKm: tripKm((doc.stops ?? []) as StopLeg[]), stage: currentStage(doc) };
};

export async function listTrips(query: S.TripListQuery) {
  const filter: Plain = {};
  if (query.state === 'open') filter.active = true;
  if (query.state === 'planned') Object.assign(filter, { active: true, dispatchedAt: { $exists: false } });
  if (query.state === 'on_road') Object.assign(filter, { active: true, dispatchedAt: { $exists: true } });
  if (query.state === 'ended') Object.assign(filter, TO_SETTLE);
  if (query.state === 'settled') filter.settlementId = { $exists: true };
  if (query.state === 'cancelled') filter.cancelledAt = { $exists: true };
  for (const key of ['driverId', 'vehicleId', 'customerId', 'nominationId'] as const) if (query[key]) filter[key] = query[key];
  if (query.search) filter.number = { $regex: query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  const [rows, total] = await Promise.all([
    Trip.find(filter).sort({ createdAt: -1, _id: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
    Trip.countDocuments(filter),
  ]);
  return { data: rows.map((r) => presentTrip(r as Plain)), total, page: query.page, limit: query.limit };
}

export async function getTrip(id: string) {
  const trip = await Trip.findById(id).lean();
  if (!trip) throw new NotFoundError('Trip not found');
  return presentTrip(trip as Plain);
}

async function tripDoc(id: unknown) {
  const trip = await Trip.findById(id);
  if (!trip) throw new NotFoundError('Trip not found');
  return trip;
}

/* ---------- Busy checks ---------- */

/** A work order that stops the truck keeps it off new trips (#63). While Maintenance is off, no order holds anything. */
async function assertNotHeld(vehicleId: unknown, plate: string) {
  if (!(await isAreaOn('maintenance'))) return;
  const order = await WorkOrder.findOne({ vehicleId, status: 'active', stopsTruck: true, stage: { $ne: 'done' } }).select('number stage').lean<{ number: string; stage: string }>();
  if (order) throw conflict(`${plate} is ${order.stage === 'in_workshop' ? 'in the workshop' : 'waiting for the workshop'} on work order ${order.number}. Finish the order, or say it doesn't stop the truck, before giving it a trip.`);
}

/** The km a finished trip drove go on the truck's reading. A truck with no reading yet has nothing to add to. */
async function addToOdometer(vehicleId: unknown, km: number) {
  if (km > 0) await Vehicle.updateOne({ _id: vehicleId, odometerKm: { $exists: true } }, { $inc: { odometerKm: Math.round(km) } });
}

export async function assertFree(field: 'vehicleId' | 'driverId' | 'trailerId', id: unknown, label: string, except?: unknown) {
  if (!id) return;
  const filter: Plain = { [field]: id, active: true };
  if (except) filter._id = { $ne: except };
  if (await Trip.exists(filter)) throw conflict(`${label} is already on a trip.`);
}

/* ---------- Plan ---------- */

export async function createTrip(input: S.CreateTripInput, ctx: OpsContext, extra: { nominationId?: unknown; transferredFromTripId?: unknown } = {}) {
  need(ctx, 'trips', 'create');
  const at = new Date();
  const customer = await customerParty(input.customerId);
  const truck = await truckFacts(input.vehicleId);
  await assertFree('vehicleId', input.vehicleId, truck.plate);
  await assertNotHeld(input.vehicleId, truck.plate);
  const driver = input.driverId ? await activeDriver(input.driverId) : null;
  if (driver) await assertFree('driverId', input.driverId, String(driver.name));
  const trailer = input.trailerId ? await activeRecord(Trailer, input.trailerId, 'trailer') : null;
  if (trailer) await assertFree('trailerId', input.trailerId, String(trailer.registrationNumber));
  const route = input.routeId ? await activeRecord(Route, input.routeId, 'route') : null;
  if (input.productId) await activeRecord(Product, input.productId, 'product');
  const tripType = await tripTypeFor(input.tripTypeId);
  const { tripStartsFromTruck } = await operationsSettings();
  const routePlan = route ? (route.stops as Array<{ placeId: unknown; kind: string }>).map((s) => ({ placeId: String(s.placeId), kind: s.kind })) : [];
  const plan = input.stops ?? (tripStartsFromTruck ? stopsFromTruck(routePlan, truck.placeId) : routePlan);
  if (tripStartsFromTruck && plan[0] && truck.placeId && plan[0].placeId !== truck.placeId) throw refuse(`${truck.plate} is at ${await placeName(truck.placeId)}. The trip starts there.`);
  const stops = plan.length ? await buildStops(plan, { tripsWithoutCargo: (await freightSettings()).tripsWithoutCargo }) : [];
  const draft: Plain = {
    customerId: customer._id, vehicleId: truck.vehicle._id, driverId: driver?._id, trailerId: trailer?._id, routeId: route?._id,
    productId: input.productId, plannedQty: input.plannedQty, plannedStart: input.plannedStart, stops, nominationId: extra.nominationId,
  };
  const trip = new Trip({
    ...draft, ...(await budgets(draft, truck)), number: await nextNumber('trips', 'TRIP', at),
    // A transfer or a nomination's trip has no one to ask here: anything required is asked before it leaves.
    custom: extra.transferredFromTripId || extra.nominationId ? input.custom : await stepCustom('trips', 'create', input.custom),
    openingFuelL: truck.fuelL, tripTypeId: tripType?._id, stages: await stageSnapshot(tripType?._id), transferredFromTripId: extra.transferredFromTripId, createdBy: ctx.actorId, updatedBy: ctx.actorId,
  });
  // Its consignments are checked before anything is saved, so a refused one doesn't leave a trip behind (#135).
  const prepared = [];
  for (const c of input.consignments ?? []) prepared.push({ input: c, ready: await prepareConsignment(c, trip.toObject() as Plain, ctx) });
  recordEvent(trip, 'created', at, ctx.actorId);
  await save(trip, `${truck.plate}, its driver or its trailer is already on a trip.`);
  for (const { input: c, ready } of prepared) await createOnTrip(trip, c, ctx, ready);
  if (tripStartsFromTruck && !truck.placeId && plan[0]) await setVehicleState(truck.vehicle._id, { placeId: plan[0].placeId }, ctx.actorId);
  if (driver) {
    await post(driverThread(driver._id), at, {
      title: `New trip ${trip.get('number')}`,
      text: `${truck.plate}${trailer ? ` with ${trailer.registrationNumber}` : ''} for ${customer.name}. ${stops.length ? await routeLabel(trip.toObject()) : 'Route to follow'}.`,
      rows: [['Planned start', Fmt.dateTime(input.plannedStart)]],
      wa: { template: 'trip_assigned', values: [String(trip.get('number')), `${truck.plate}${trailer ? ` with ${trailer.registrationNumber}` : ''}`, String(customer.name), stops.length ? await routeLabel(trip.toObject()) : 'route to follow', Fmt.dateTime(input.plannedStart)] },
    }, ctx);
  }
  await log(ctx, at, `${trip.get('number')} created: ${truck.plate} for ${customer.name}`, { tripId: trip._id });
  return presentTrip(trip.toObject());
}

export async function updateTrip(id: string, input: S.UpdateTripInput, ctx: OpsContext) {
  need(ctx, 'trips', 'update');
  const at = new Date();
  const trip = await tripDoc(id);
  if (trip.get('version') !== input.version) throw conflict('This trip was changed by someone else. Reload it and try again.');
  if (trip.get('dispatchedAt') || !activeTrip(trip.toObject())) throw conflict('The trip is on the road. Its plan is locked.');
  const truck = await truckFacts(trip.get('vehicleId'), false);
  if (input.customerId) {
    if (trip.get('nominationId') && String(input.customerId) !== String(trip.get('customerId'))) throw refuse('This trip belongs to a nomination; the customer is fixed.');
    await customerParty(input.customerId);
    trip.set('customerId', input.customerId);
  }
  if (input.driverId !== undefined && String(input.driverId ?? '') !== String(trip.get('driverId') ?? '')) {
    if (input.driverId) {
      const driver = await activeDriver(input.driverId);
      await assertFree('driverId', input.driverId, String(driver.name), trip._id);
    }
    if (await FundRequest.exists({ tripId: trip._id, kind: 'cash', status: 'issued' })) throw conflict('The advance was paid to the current driver. Keep the driver or cancel this trip.');
    trip.set('driverId', input.driverId ?? undefined);
    if (input.driverId) {
      const customerName = await partyName(trip.get('customerId'));
      const route = await routeLabel(trip.toObject());
      await post(driverThread(input.driverId), at, {
        title: `New trip ${trip.get('number')}`, text: `${truck.plate} for ${customerName}. ${route}.`,
        wa: { template: 'trip_assigned', values: [String(trip.get('number')), truck.plate, customerName, route, Fmt.dateTime(trip.get('plannedStart'))] },
      }, ctx);
    }
  }
  if (input.trailerId !== undefined && String(input.trailerId ?? '') !== String(trip.get('trailerId') ?? '')) {
    if (input.trailerId) {
      const trailer = await activeRecord(Trailer, input.trailerId, 'trailer');
      await assertFree('trailerId', input.trailerId, String(trailer.registrationNumber), trip._id);
    }
    trip.set('trailerId', input.trailerId ?? undefined);
  }
  if (input.routeId !== undefined) {
    if (input.routeId) await activeRecord(Route, input.routeId, 'route');
    trip.set('routeId', input.routeId ?? undefined);
  }
  if (input.stops) {
    if ((await operationsSettings()).tripStartsFromTruck && truck.placeId && input.stops[0]?.placeId !== truck.placeId) throw refuse(`${truck.plate} is at ${await placeName(truck.placeId)}. The trip starts there.`);
    trip.set('stops', await buildStops(input.stops, { tripsWithoutCargo: (await freightSettings()).tripsWithoutCargo }));
    // The plan changed: its consignments' pickups and drops find their stops again.
    await reattachAll(trip, ctx);
  }
  if (input.stops || input.routeId !== undefined) trip.set(await budgets(trip.toObject(), truck));
  if (input.plannedStart) trip.set('plannedStart', input.plannedStart);
  if (input.productId !== undefined) {
    if (input.productId) await activeRecord(Product, input.productId, 'product');
    trip.set('productId', input.productId ?? undefined);
  }
  if (input.plannedQty !== undefined) trip.set('plannedQty', input.plannedQty ?? undefined);
  if (input.fuelBudgetL !== undefined) trip.set('fuelBudgetL', input.fuelBudgetL);
  if (input.cashBudgetMinor !== undefined) trip.set('cashBudget', { amountMinor: input.cashBudgetMinor, currencyId: (await baseCurrency()).id });
  trip.set('updatedBy', ctx.actorId);
  await save(trip, 'That truck, driver or trailer is already on a trip.');
  await log(ctx, at, 'Plan updated', { tripId: trip._id });
  return presentTrip(trip.toObject());
}

export async function cancelTrip(id: string, input: S.ReasonInput, ctx: OpsContext) {
  need(ctx, 'trips', 'update');
  const at = new Date();
  const trip = await tripDoc(id);
  if ((await Consignment.find({ tripId: trip._id }).lean()).some((c) => isLoaded(c as never) && !isFinished(c as never))) throw conflict("This trip carries a load from another truck. Say what happens to the load with \"Can't deliver\".");
  if (trip.get('dispatchedAt')) throw conflict('The truck has left. End the trip instead.');
  if (!activeTrip(trip.toObject())) throw conflict('This trip is already closed.');
  // Cash already paid or spent on the trip stays with the driver; the trip then goes on their next settlement.
  const cashOnTrip = Boolean(
    (await FundRequest.exists({ tripId: trip._id, kind: 'cash', status: 'issued' })) ||
    (await Expense.exists({ tripId: trip._id, status: { $in: ['pending', 'approved'] } })),
  );
  trip.set({ cancelledAt: at, cancelReason: input.reason, active: false, settleAfterCancel: cashOnTrip || undefined, updatedBy: ctx.actorId });
  await save(trip);
  await cancelPlanned(trip._id, `Trip cancelled: ${input.reason}`, ctx);
  for (const request of await FundRequest.find({ tripId: trip._id, status: { $in: OPEN_REQUEST } })) {
    request.set('status', 'cancelled');
    request.get('trail').push({ desk: ctx.desk, userId: ctx.actorId, name: ctx.name, what: 'cancelled', at, note: 'Trip cancelled', via: 'app' });
    await save(request);
    await resolve(String(request._id), 'Trip cancelled');
    await resolve(`${request._id}-issue`, 'Trip cancelled');
  }
  if (trip.get('nominationId')) await Nomination.updateOne({ _id: trip.get('nominationId') }, { $pull: { tripIds: trip._id }, $inc: { version: 1 } });
  if (trip.get('driverId')) await post(driverThread(trip.get('driverId')), at, { text: `${trip.get('number')} is cancelled. ${input.reason}`, wa: { template: 'trip_stopped', values: [String(trip.get('number')), 'cancelled', input.reason] } }, ctx);
  await log(ctx, at, `Cancelled: ${input.reason}`, { tripId: trip._id });
  return presentTrip(trip.toObject());
}

/**
 * A trip that left but will never load (the customer cancelled, the truck broke down on the way) is
 * stopped: it closes where the truck is, open money requests are cancelled, and the truck, trailer
 * and driver are free. Cash already paid stays with the driver and the trip goes on their next
 * settlement, like an ended trip. A company can switch this off (operations.stopBeforeLoading).
 */
/** Closes a trip that won't reach its end: the truck is where it is, open money requests are cancelled, and cash paid goes to settlement. */
export async function closeEarly(trip: HydratedDocument<any>, close: { reason: string; placeId: unknown; closingFuelL: number; requestNote: string }, at: Date, ctx: OpsContext) {
  trip.set({ endedAt: at, stopReason: close.reason, closingFuelL: close.closingFuelL, active: false, updatedBy: ctx.actorId });
  const tracking = trip.get('tracking');
  if (tracking) trip.set('tracking.speed', 0);
  await save(trip);
  await setVehicleState(trip.get('vehicleId'), { placeId: close.placeId, fuelL: close.closingFuelL }, ctx.actorId);
  for (const request of await FundRequest.find({ tripId: trip._id, status: { $in: OPEN_REQUEST } })) {
    request.set('status', 'cancelled');
    request.get('trail').push({ desk: ctx.desk, userId: ctx.actorId, name: ctx.name, what: 'cancelled', at, note: close.requestNote, via: 'app' });
    await save(request);
    await resolve(String(request._id), 'Trip stopped');
    await resolve(`${request._id}-issue`, 'Trip stopped');
  }
  await resolve(`${trip._id}-end`, 'Trip stopped');
}

export async function stopTrip(id: string, input: S.StopTripInput, ctx: OpsContext) {
  need(ctx, 'trips', 'update');
  const at = new Date();
  const trip = await tripDoc(id);
  if (!trip.get('dispatchedAt')) throw conflict("This trip hasn't left yet. Cancel it instead.");
  if (!activeTrip(trip.toObject())) throw conflict('This trip is already closed.');
  if (!(await operationsSettings()).stopBeforeLoading) throw refuse('This company does not stop trips before loading. Ask an administrator to switch it on in Company settings.');
  if ((await Consignment.find({ tripId: trip._id }).lean()).some((c) => isLoaded(c as never))) throw refuse('The cargo is loaded, so the trip can only end after delivery.');
  const truck = await truckFacts(trip.get('vehicleId'), false);
  if (truck.tankL && input.closingFuelL > truck.tankL) throw refuse(`The tank holds ${litres(truck.tankL)}.`);
  const stops = trip.get('stops') as Array<{ placeId: unknown; arrivedAt?: Date }>;
  // Where the truck is: the place given, or the last stop it reached.
  const placeId = input.placeId ?? [...stops].reverse().find((s) => s.arrivedAt)?.placeId ?? stops[0]!.placeId;
  await addToOdometer(trip.get('vehicleId'), Number(trip.get('tracking')?.km ?? 0));
  await closeEarly(trip, { reason: input.reason, placeId, closingFuelL: input.closingFuelL, requestNote: 'Trip stopped before loading' }, at, ctx);
  await cancelPlanned(trip._id, `Trip stopped before loading: ${input.reason}`, ctx);
  const place = await placeName(placeId);
  const number = String(trip.get('number'));
  if (trip.get('driverId')) await post(driverThread(trip.get('driverId')), at, { title: `${number} stopped`, text: `${input.reason} Park the truck at ${place}.`, wa: { template: 'trip_stopped', values: [number, 'stopped', `${input.reason.replace(/\.\s*$/, '')}; park the truck at ${place}`] } }, ctx);
  await post(queue('trips'), at, { title: `${number} stopped before loading`, text: `${input.reason} ${truck.plate} is free at ${place} with ${litres(input.closingFuelL)}.` }, ctx);
  await log(ctx, at, `Stopped before loading at ${place}: ${input.reason}`, { tripId: trip._id });
  return presentTrip(trip.toObject());
}

/* ---------- Funding suggestion ---------- */

/** Fuel in the tank now: on a trip under way, the level less what the km driven used, as the desks show it (#92). */
export function fuelInTank(trip: Plain, truck: Truck) {
  if (!trip.dispatchedAt || trip.endedAt) return truck.fuelL;
  const km = Number((trip.tracking as Plain | undefined)?.km ?? 0);
  const kmPerL = truck.kmPerLLoaded ?? truck.kmPerLEmpty;
  return kmPerL ? Math.max(0, Math.round(truck.fuelL - km / kmPerL)) : truck.fuelL;
}

/** A driver's trip for a message or document: the one under way, or else the latest ended one not yet settled (#92). */
export async function driverTripNow(driverId: unknown) {
  return ((await Trip.findOne({ driverId, active: true }).sort({ createdAt: -1 }).lean())
    ?? (await Trip.findOne({ driverId, ...TO_SETTLE }).sort({ endedAt: -1, createdAt: -1 }).lean())) as Plain | null;
}

export async function fundingFor(trip: Plain) {
  const truck = await truckFacts(trip.vehicleId, false);
  const base = await baseCurrency();
  const requests = await FundRequest.find({ tripId: trip._id ?? trip.id }).lean();
  const litresOf = (statuses: string[]) => requests.filter((r) => r.kind === 'fuel' && statuses.includes(String(r.status))).reduce((s, r) => s + Number(r.litres ?? 0), 0);
  let cashOpen = 0;
  for (const r of requests.filter((x) => x.kind === 'cash' && OPEN_REQUEST.includes(String(x.status)))) cashOpen += (await toBase(r.amount.amountMinor, r.amount.currencyId)).baseMinor;
  const cashIssued = requests.filter((r) => r.kind === 'cash' && r.status === 'issued').reduce((s, r) => s + Number(r.baseAmountMinor ?? 0), 0);
  const fuelIssued = litresOf(['issued']);
  const fuelOpen = litresOf(OPEN_REQUEST);
  const room = truck.tankL ? Math.max(0, truck.tankL - fuelInTank(trip, truck) - fuelOpen) : Number.MAX_SAFE_INTEGER;
  const fuelSuggested = Math.min(room, Math.max(0, Math.ceil(Number(trip.fuelBudgetL) - Number(trip.openingFuelL) - fuelIssued - fuelOpen)));
  const holds = trip.driverId ? await carriedIn(trip.driverId, trip._id ?? trip.id) : 0;
  const cashBudget = Number((trip.cashBudget as { amountMinor: number }).amountMinor);
  return {
    currency: base,
    fuel: { budget: Number(trip.fuelBudgetL), onTruck: Number(trip.openingFuelL), inTank: truck.fuelL, tank: truck.tankL ?? null, open: fuelOpen, issued: fuelIssued, suggested: fuelSuggested, room: truck.tankL ? room : null },
    cash: { budgetMinor: cashBudget, holdsMinor: holds, openMinor: cashOpen, issuedMinor: cashIssued, suggestedMinor: Math.max(0, cashBudget - Math.max(0, holds) - cashIssued - cashOpen) },
  };
}

export async function getFunding(id: string) {
  const trip = await Trip.findById(id).lean();
  if (!trip) throw new NotFoundError('Trip not found');
  return fundingFor(trip as Plain);
}

/* ---------- On the road ---------- */

export async function dispatchTrip(id: string, ctx: OpsContext, input?: S.DispatchInput) {
  need(ctx, 'trips', 'update');
  const at = new Date();
  const trip = await tripDoc(id);
  if (trip.get('dispatchedAt')) throw conflict('Already on the road.');
  if (!activeTrip(trip.toObject())) throw conflict('This trip is closed.');
  if (!trip.get('driverId')) throw refuse('Assign the driver first.');
  if (!trip.get('stops').length) throw refuse('Set the route first.');
  assertStageAllows(trip.toObject(), 'dispatched');
  const open = await FundRequest.findOne({ tripId: trip._id, status: { $in: OPEN_REQUEST } }).lean();
  if (open) throw conflict(open.status === 'approved' ? `${open.number} still has to be paid.` : `${waitingOn(open.approval as Approval)?.label ?? 'The approver'} still has to approve ${open.number}.`);
  const truck = await truckFacts(trip.get('vehicleId'), false);
  await assertNotHeld(trip.get('vehicleId'), truck.plate);
  const issued = (await FundRequest.find({ tripId: trip._id, kind: 'fuel', status: 'issued' }).lean()).reduce((s, r) => s + Number(r.litres ?? 0), 0);
  const stops = trip.get('stops');
  stops[0].arrivedAt ??= at;
  stops[0].leftAt = at;
  trip.set('custom', await stepCustom('trips', 'dispatch', input?.custom, (trip.toObject() as Plain).custom as Plain | undefined, ['create']));
  recordEvent(trip, 'dispatched', at, ctx.actorId);
  // A trip that took over a load from another truck leaves already loaded.
  const consignments = working(await Consignment.find({ tripId: trip._id }).lean() as never, trip._id);
  if ((await freightSettings()).consignmentBy === 'dispatch' && !consignments.length) throw refuse('Add the consignment for this trip first: this company books consignments before the truck leaves.');
  if (consignments.some((c) => isLoaded(c))) recordEvent(trip, 'loaded', at, ctx.actorId);
  trip.set({ dispatchedAt: at, openingFuelL: Math.max(0, round(truck.fuelL - issued, 0)), tracking: { km: 0, speed: 0, heading: 0, at }, updatedBy: ctx.actorId });
  await save(trip);
  await resolve(`${trip._id}-dispatch`, 'Dispatched');
  const plain = trip.toObject() as Plain;
  const base = await baseCurrency();
  const holds = Math.max(0, await carriedIn(plain.driverId, trip._id)) + (await FundRequest.find({ tripId: trip._id, kind: 'cash', status: 'issued' }).lean()).reduce((s, r) => s + Number(r.baseAmountMinor ?? 0), 0);
  const plainStops = plain.stops as Array<{ kind: string; placeId: unknown }>;
  const loadAt = await placeName(plainStops.find((s) => s.kind === 'load')?.placeId);
  // The last drop, where the trip's work ends, not the first (#102).
  const offloadAt = await placeName([...plainStops].reverse().find((s) => s.kind === 'offload')?.placeId);
  const truckLabel = `${truck.plate}${plain.trailerId ? ` · ${await trailerPlate(plain.trailerId)}` : ''}`;
  await post(driverThread(plain.driverId), at, {
    title: `On your way · ${plain.number}`,
    text: `Head to ${loadAt} for loading. Offload at ${offloadAt}.`,
    rows: [['Truck', truckLabel], ['Fuel in tank', litres(truck.fuelL)], ['Cash with you', formatMoney(holds, base)]],
    wa: { template: 'trip_dispatched', values: [String(plain.number), loadAt, offloadAt, truckLabel, litres(truck.fuelL), formatMoney(holds, base)] },
  }, ctx);
  await log(ctx, at, `Dispatched from ${await placeName(plainStops[0]?.placeId)}`, { tripId: trip._id });
  await announce('trip.dispatched', plain, ctx, { variables: { 'place.name': await placeName(plainStops[0]?.placeId) } });
  return presentTrip(plain);
}

/** Messages when a truck reaches a loading point, an offloading point or the end. */
async function announceArrival(trip: Plain, index: number, at: Date, ctx: OpsContext, via: ArrivalSource) {
  const stops = trip.stops as Array<{ kind: string; placeId: unknown }>;
  const stop = stops[index]!;
  // A demo drive says so wherever its arrivals show up, so nobody acts on them as real.
  const place = `${await placeName(stop.placeId)}${via === 'simulator' ? ' (simulated)' : ''}`;
  const driver = trip.driverId ? await driverName(trip.driverId) : '';
  if (stop.kind === 'load' || stop.kind === 'offload') {
    const loading = stop.kind === 'load';
    await log(ctx, at, `Reached ${place} for ${loading ? 'loading' : 'offloading'}`, { tripId: trip._id });
    if (trip.driverId) {
      await post(driverThread(trip.driverId), at, {
        title: `You've reached ${place}`,
        text: loading ? 'Send a photo of the loading invoice once the truck is loaded.' : 'Send the signed delivery note with the offloading readings.',
        buttons: [{ label: loading ? 'Send loading invoice' : 'Send delivery note', attach: loading ? 'loading' : 'delivery', tone: 'primary' }],
        wa: { template: 'arrived_send_document', values: [place, String(trip.number), loading ? 'the loading invoice once the truck is loaded' : 'the signed delivery note with the offloading readings'] },
        refId: `${trip._id}-${loading ? 'loading' : 'delivery'}`,
      }, ctx);
    }
    await post(queue('consignments'), at, {
      title: `${trip.number} reached ${place}`,
      text: `${firstName(driver)} will send the ${loading ? 'loading invoice' : 'delivery note'}.`,
      buttons: [{ label: 'Open trip', nav: { tripId: String(trip._id) } }],
    }, ctx);
    await announce(loading ? 'trip.arrived_loading' : 'trip.arrived_offloading', trip, ctx, { variables: { 'place.name': place } });
  } else if (stop.kind === 'via' || stop.kind === 'border') {
    await log(ctx, at, `Passed ${place}`, { tripId: trip._id });
  } else if (stop.kind === 'end') {
    await log(ctx, at, `Arrived at ${place}`, { tripId: trip._id });
    await post(queue('trips'), at, {
      title: `${trip.number} is at ${place}`,
      text: 'Record the fuel left in the tank to end the trip and free the truck.',
      buttons: [{ label: 'End trip', tone: 'primary', nav: { tripId: String(trip._id), view: 'close' } }],
      refId: `${trip._id}-end`,
    }, ctx);
  }
}

/**
 * Why the truck can't be at this stop yet, if it can't. Stops follow the cargo: nothing after the loading
 * point before the loading is recorded, and nothing after the offloading point before the delivery is.
 */
export async function arrivalRefusal(trip: HydratedDocument<any>, index: number, ctx: OpsContext): Promise<string | undefined> {
  const gate = await tripGate(trip.toObject() as Plain);
  if (!gate || index <= gate.index) return undefined;
  // The office records these; a driver can only wait for it.
  return ctx.asDriver ? gate.driverReason : gate.reason;
}

/** Stamps arrival at a stop (and the stops passed before it) and sends the messages for it. Refuses a stop the cargo hasn't reached. */
export async function arriveAt(trip: HydratedDocument<any>, index: number, at: Date, ctx: OpsContext, via: ArrivalSource, quiet = false) {
  const stops = trip.get('stops') as Array<{ legKm: number; arrivedAt?: Date; leftAt?: Date; arrivedVia?: ArrivalSource; kind: string }>;
  if (!stops[index]?.arrivedAt) {
    const refusal = await arrivalRefusal(trip, index, ctx);
    if (refusal) throw refuse(refusal);
  }
  await leaveAfterWork(trip, stops.slice(0, index), at);
  const stamped = stampArrival(stops, index, at);
  if (!stamped) return;
  for (const stop of stops.slice(0, index + 1)) if (stop.arrivedAt && !stop.arrivedVia) stop.arrivedVia = via;
  if (stops[index]?.kind === 'offload') recordEvent(trip, 'arrived_offloading', at, ctx.actorId);
  if (!quiet) await announceArrival(trip.toObject() as Plain, index, at, ctx, via);
}

/**
 * A stop the truck goes on from is left no earlier than the work recorded there (#102): when the office marks the
 * next arrival without GPS, the loading or drop recorded after the truck arrived sets when it left, not the arrival.
 */
async function leaveAfterWork(trip: HydratedDocument<any>, stops: Array<{ _id?: unknown; arrivedAt?: Date; leftAt?: Date }>, at: Date) {
  const open = stops.filter((s) => s.arrivedAt && !s.leftAt);
  if (!open.length) return;
  const done = new Map<string, number>();
  const list = await Consignment.find({ 'legs.tripId': trip._id }).select('legs.stopId legs.recordedAt').lean();
  for (const c of list) for (const l of (c.legs ?? []) as Array<{ stopId?: unknown; recordedAt?: Date }>) {
    if (l.stopId && l.recordedAt) done.set(String(l.stopId), Math.max(done.get(String(l.stopId)) ?? 0, l.recordedAt.getTime()));
  }
  for (const s of open) {
    const work = done.get(String(s._id));
    if (work) s.leftAt = new Date(Math.min(at.getTime(), Math.max(s.arrivedAt!.getTime(), work)));
  }
}

/** A position report: kilometres along the route. The truck can't pass loading before the load is recorded, or offloading before delivery. */
export async function reportPosition(id: string, input: S.PositionInput, ctx: OpsContext) {
  need(ctx, 'trips', 'update');
  if (input.source === 'simulator' && !env.DRIVER_PHONE_SIMULATOR) throw new ForbiddenError('The drive simulator is switched off for this installation');
  const at = new Date();
  const trip = await tripDoc(id);
  if (!trip.get('dispatchedAt') || !activeTrip(trip.toObject())) throw conflict('Dispatch the trip to start tracking.');
  const stops = trip.get('stops') as Array<{ kind: string; legKm: number; arrivedAt?: Date; leftAt?: Date }>;
  const cum = cumulativeKm(stops);
  const end = cum.at(-1) ?? 0;
  const previous = Number(trip.get('tracking')?.km ?? 0);
  let km = Math.max(previous, Math.min(input.km, end));
  // The truck can't pass the stop that holds it (design 3.7.2): the km stop there until its consignments are recorded.
  const gate = await tripGate(trip.toObject() as Plain);
  if (gate) km = Math.min(km, cum[gate.index]!);
  const held = km < Math.min(input.km, end) - 0.01;
  const arrivals: number[] = [];
  stops.forEach((stop, index) => {
    if (gate && index > gate.index) return;
    if (index > 0 && !stop.arrivedAt && km >= cum[index]! - 0.01) arrivals.push(index);
  });
  for (const index of arrivals) await arriveAt(trip, index, at, ctx, input.source);
  const passed = stops.filter((stop, index) => stop.arrivedAt && !stop.leftAt && km > cum[index]! + 0.5);
  stops.forEach((stop, index) => {
    if (passed.includes(stop)) {
      const back = input.speed > 0 ? ((km - cum[index]!) / input.speed) * 36e5 : 0;
      stop.leftAt = new Date(Math.max(stop.arrivedAt!.getTime(), at.getTime() - back));
    }
  });
  // Never before the work recorded there.
  for (const stop of passed) {
    const left = stop.leftAt!;
    stop.leftAt = undefined;
    await leaveAfterWork(trip, [stop], at);
    const after = stop.leftAt as Date | undefined;
    if (!after || after < left) stop.leftAt = left;
  }
  const parked = stops.some((s, i) => s.kind !== 'via' && s.kind !== 'border' && s.kind !== 'start' && s.arrivedAt && !s.leftAt && Math.abs(cum[i]! - km) < 0.5);
  trip.set('tracking', { km, speed: km > previous && !held && !parked ? input.speed : 0, heading: km > previous ? input.heading ?? 0 : Number(trip.get('tracking')?.heading ?? 0), at, source: input.source });
  trip.markModified('stops');
  await save(trip);
  return presentTrip(trip.toObject());
}

export async function arriveAtStop(id: string, stopId: string, ctx: OpsContext) {
  need(ctx, 'trips', 'update');
  const at = new Date();
  const trip = await tripDoc(id);
  if (!trip.get('dispatchedAt') || !activeTrip(trip.toObject())) throw conflict('Dispatch the trip first.');
  const stops = trip.get('stops') as Array<{ _id: unknown; kind: string; legKm: number }>;
  const index = stops.findIndex((s) => String(s._id) === stopId);
  if (index < 0) throw new NotFoundError('Stop not found');
  // Checked before the tracking moves, so a refused arrival leaves the truck where it was.
  if (!(stops[index] as { arrivedAt?: Date }).arrivedAt) {
    const refusal = await arrivalRefusal(trip, index, ctx);
    if (refusal) throw refuse(refusal);
  }
  const via = ctx.asDriver ? 'driver' : 'office';
  trip.set('tracking', { ...(trip.get('tracking')?.toObject?.() ?? { heading: 0 }), km: cumulativeKm(stops)[index], speed: 0, at, source: via });
  await arriveAt(trip, index, at, ctx, via);
  trip.markModified('stops');
  await save(trip);
  return presentTrip(trip.toObject());
}

/** Reminds whoever the trip is waiting on: Finance or the owner for money, otherwise the driver for a document. */
export async function remind(id: string, ctx: OpsContext) {
  need(ctx, 'messages', 'create');
  const at = new Date();
  const trip = (await Trip.findById(id).lean()) as Plain | null;
  if (!trip) throw new NotFoundError('Trip not found');
  const open = await FundRequest.findOne({ tripId: trip._id, status: { $in: OPEN_REQUEST } }).lean();
  if (open) {
    const thread = open.status === 'approved' ? queue('payments') : waitingOn(open.approval as Approval)?.thread ?? queue('fund-approvals');
    const who = open.status === 'approved' ? 'payments' : waitingOn(open.approval as Approval)?.label ?? 'the approver';
    await post(thread, at, {
      title: `Reminder from ${ctx.name}`,
      text: `${trip.number} is waiting for you to ${open.status === 'approved' ? 'pay' : 'approve'} ${open.number} (${await requestAmount(open as Plain)}).`,
      buttons: open.status === 'approved' ? await issueButtons(open as Plain) : requestButtons(open as Plain),
      refId: open.status === 'approved' ? `${open._id}-issue` : String(open._id),
    }, ctx);
    await log(ctx, at, `Reminded ${who} about ${open.number}`, { tripId: trip._id });
    return { reminded: thread };
  }
  if (!trip.driverId) throw refuse('Nobody to remind: no open request and no driver.');
  // What the driver is to send: what the stop holding the truck waits for, else the delivery note once loaded.
  const consignments = await Consignment.find({ tripId: trip._id, status: { $nin: ['cancelled', 'draft'] } }).lean();
  const gate = await tripGate(trip, consignments as Plain[]);
  const loaded = consignments.some((c) => isLoaded(c as never));
  const kind = gate ? (gate.why === 'drop' || (gate.why === 'document' && (trip.stops as Plain[])[gate.index]?.kind === 'offload') ? 'delivery' : gate.why === 'pickup' || gate.why === 'no_consignment' || gate.why === 'document' ? 'loading' : loaded ? 'delivery' : 'loading') : loaded ? 'delivery' : 'loading';
  await post(driverThread(trip.driverId), at, {
    title: `Reminder · ${trip.number}`,
    text: 'Operations is waiting for your document.',
    buttons: [{ label: 'Send it now', tone: 'primary', attach: kind }],
    wa: { template: 'document_reminder', values: [String(trip.number), kind === 'delivery' ? 'delivery note' : 'loading invoice'] },
  }, ctx);
  await log(ctx, at, 'Reminded the driver', { tripId: trip._id });
  return { reminded: 'driver' };
}

/* ---------- Close ---------- */

export async function endTrip(id: string, input: S.EndTripInput, ctx: OpsContext) {
  need(ctx, 'trips', 'update');
  const at = new Date();
  const trip = await tripDoc(id);
  if (!trip.get('dispatchedAt') || !activeTrip(trip.toObject())) throw conflict("This trip isn't on the road.");
  assertStageAllows(trip.toObject(), 'ended');
  const consignments = working(await Consignment.find({ tripId: trip._id }).lean() as never, trip._id);
  const { tripsWithoutCargo } = await freightSettings();
  if (!consignments.some((c) => isLoaded(c)) && !tripsWithoutCargo) throw refuse('Nothing was loaded on this trip.');
  const open = consignments.filter((c) => !isFinished(c));
  if (open.length) throw refuse(open.length === 1 && consignments.length === 1 ? 'Record the delivery first.' : `Record the delivery of ${open.map((c) => c.number).join(', ')} first, or say what happens to ${open.length === 1 ? 'it' : 'them'} with "Can't deliver".`);
  const truck = await truckFacts(trip.get('vehicleId'), false);
  if (truck.tankL && input.closingFuelL > truck.tankL) throw refuse(`The tank holds ${litres(truck.tankL)}.`);
  const stops = trip.get('stops') as Array<{ placeId: unknown; legKm: number; leftAt?: Date }>;
  for (let i = 0; i < stops.length; i += 1) stampArrival(stops, i, at);
  stops.at(-1)!.leftAt = undefined;
  const endPlace = stops.at(-1)!.placeId;
  trip.set('custom', await stepCustom('trips', 'close', input.custom, (trip.toObject() as Plain).custom as Plain | undefined));
  recordEvent(trip, 'ended', at, ctx.actorId);
  trip.set({ endedAt: at, closingFuelL: input.closingFuelL, active: false, tracking: { ...(trip.get('tracking')?.toObject?.() ?? { heading: 0 }), km: tripKm(stops), speed: 0, at }, updatedBy: ctx.actorId });
  trip.markModified('stops');
  await save(trip);
  await setVehicleState(trip.get('vehicleId'), { placeId: endPlace, fuelL: input.closingFuelL }, ctx.actorId);
  await addToOdometer(trip.get('vehicleId'), tripKm(stops));
  await resolve(`${trip._id}-end`, 'Trip ended');
  const plain = trip.toObject() as Plain;
  const place = await placeName(endPlace);
  if (plain.driverId) {
    const name = await driverName(plain.driverId);
    const unsettled = await Trip.countDocuments({ driverId: plain.driverId, ...TO_SETTLE });
    const base = await baseCurrency();
    await post(driverThread(plain.driverId), at, { title: `${plain.number} closed`, text: `Truck parked at ${place} with ${litres(input.closingFuelL)}. Thank you.`, wa: { template: 'trip_closed', values: [String(plain.number), `truck parked at ${place} with ${litres(input.closingFuelL)}`] } }, ctx);
    await post(queue('settlements'), at, {
      title: `${plain.number} ended`,
      text: `${name} has ${unsettled} trip${unsettled > 1 ? 's' : ''} to settle. Balance ${formatMoney(await driverBalance(plain.driverId), base)}.`,
      buttons: [{ label: 'Open statement', tone: 'primary', nav: { view: 'settle', driverId: String(plain.driverId) } }],
    }, ctx);
  }
  const label = await routeLabel(plain as never);
  await post(queue('trips'), at, { title: `Trip sheet ready · ${plain.number}`, text: `${label}, ${Fmt.number(Math.round(tripKm(stops)))} km. ${truck.plate} is free at ${place}.`, buttons: [{ label: 'View trip sheet', nav: { tripId: String(plain._id), view: 'sheet' } }] }, ctx);
  await log(ctx, at, `Ended at ${place} · ${litres(input.closingFuelL)} in the tank`, { tripId: trip._id });
  await announce('trip.closed', plain, ctx, {
    variables: { 'place.name': place },
    // The trip sheet goes with the e-mails; it is only made when one is going to someone.
    attachments: async () => {
      const { printoutFile } = await import('./printouts.js');
      const file = await printoutFile('trip_sheet', String(plain._id), ctx.actorId);
      return file ? [file] : null;
    },
  });
  return presentTrip(plain);
}

