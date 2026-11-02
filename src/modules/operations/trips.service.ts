import { Types, type HydratedDocument } from 'mongoose';
import { NotFoundError } from '../../core/errors/index.js';
import type { Plain } from '../../core/masters/types.js';
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
import { issueButtons, requestAmount, requestButtons } from './funding.service.js';
import { assertStageAllows, currentStage, recordEvent, stageSnapshot, tripTypeFor } from './stages.js';
import { carriedIn, driverBalance } from './ledger.js';
import { Consignment } from './models/cargo.model.js';
import { FundRequest, OPEN_REQUEST, VehicleState } from './models/funding.model.js';
import { Nomination } from './models/money.model.js';
import { Trip } from './models/trip.model.js';
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

export async function routeLabel(trip: { stops: Array<{ kind: string; placeId: unknown }> }) {
  const load = trip.stops.find((s) => s.kind === 'load');
  const offload = trip.stops.find((s) => s.kind === 'offload');
  return `${await placeName(load?.placeId)} to ${await placeName(offload?.placeId)}`;
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
export async function buildStops(plan: StopPlan[]): Promise<Array<StopLeg & { _id: Types.ObjectId }>> {
  const { roadDistanceFactor, averageSpeedKmh } = await operationsSettings();
  const problem = validateStops(plan);
  if (problem) throw refuse(problem);
  const ids = [...new Set(plan.map((s) => s.placeId))];
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
    let km = 0;
    if (prev && prev.placeId !== stop.placeId) {
      const a = byId.get(prev.placeId)?.location as { lat: number; lng: number } | undefined;
      const b = byId.get(stop.placeId)?.location as { lat: number; lng: number } | undefined;
      km = known.get(`${prev.placeId}-${stop.placeId}`) ?? (a && b ? Math.round(haversineKm(a, b) * roadDistanceFactor) : 0);
    }
    const wait = byId.get(stop.placeId)?.type === 'border' ? waits.get(stop.placeId) ?? 0 : 0;
    return { _id: new Types.ObjectId(), placeId: stop.placeId, kind: stop.kind, legKm: km, legHours: round(km / averageSpeedKmh + (index ? wait : 0), 1) };
  });
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
  return { ...out, state: tripState(doc), totalKm: tripKm((doc.stops ?? []) as StopLeg[]), stage: currentStage(doc) };
};

export async function listTrips(query: S.TripListQuery) {
  const filter: Plain = {};
  if (query.state === 'open') filter.active = true;
  if (query.state === 'planned') Object.assign(filter, { active: true, dispatchedAt: { $exists: false } });
  if (query.state === 'on_road') Object.assign(filter, { active: true, dispatchedAt: { $exists: true } });
  if (query.state === 'ended') Object.assign(filter, { endedAt: { $exists: true }, settlementId: { $exists: false } });
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

async function assertFree(field: 'vehicleId' | 'driverId' | 'trailerId', id: unknown, label: string, except?: unknown) {
  if (!id) return;
  const filter: Plain = { [field]: id, active: true };
  if (except) filter._id = { $ne: except };
  if (await Trip.exists(filter)) throw conflict(`${label} is already on a trip.`);
}

/* ---------- Plan ---------- */

export async function createTrip(input: S.CreateTripInput, ctx: OpsContext, extra: { nominationId?: unknown } = {}) {
  need(ctx, 'trips', 'create');
  const at = new Date();
  const customer = await customerParty(input.customerId);
  const truck = await truckFacts(input.vehicleId);
  await assertFree('vehicleId', input.vehicleId, truck.plate);
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
  const stops = plan.length ? await buildStops(plan) : [];
  const draft: Plain = {
    customerId: customer._id, vehicleId: truck.vehicle._id, driverId: driver?._id, trailerId: trailer?._id, routeId: route?._id,
    productId: input.productId, plannedQty: input.plannedQty, plannedStart: input.plannedStart, stops, nominationId: extra.nominationId,
  };
  const trip = new Trip({
    ...draft, ...(await budgets(draft, truck)), number: await nextNumber('trips', 'TRIP', at),
    openingFuelL: truck.fuelL, tripTypeId: tripType?._id, stages: await stageSnapshot(tripType?._id), createdBy: ctx.actorId, updatedBy: ctx.actorId,
  });
  recordEvent(trip, 'created', at, ctx.actorId);
  await save(trip, `${truck.plate}, its driver or its trailer is already on a trip.`);
  if (tripStartsFromTruck && !truck.placeId && plan[0]) await setVehicleState(truck.vehicle._id, { placeId: plan[0].placeId }, ctx.actorId);
  if (driver) {
    await post(driverThread(driver._id), at, {
      title: `New trip ${trip.get('number')}`,
      text: `${truck.plate}${trailer ? ` with ${trailer.registrationNumber}` : ''} for ${customer.name}. ${stops.length ? await routeLabel(trip.toObject()) : 'Route to follow'}.`,
      rows: [['Planned start', new Date(input.plannedStart).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })]],
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
      await post(driverThread(input.driverId), at, { title: `New trip ${trip.get('number')}`, text: `${truck.plate} for ${await partyName(trip.get('customerId'))}. ${await routeLabel(trip.toObject())}.` }, ctx);
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
    trip.set('stops', await buildStops(input.stops));
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
  if (trip.get('dispatchedAt')) throw conflict('The truck has left. End the trip instead.');
  if (!activeTrip(trip.toObject())) throw conflict('This trip is already closed.');
  trip.set({ cancelledAt: at, cancelReason: input.reason, active: false, updatedBy: ctx.actorId });
  await save(trip);
  for (const request of await FundRequest.find({ tripId: trip._id, status: { $in: OPEN_REQUEST } })) {
    request.set('status', 'cancelled');
    request.get('trail').push({ desk: ctx.desk, userId: ctx.actorId, name: ctx.name, what: 'cancelled', at, note: 'Trip cancelled', via: 'app' });
    await save(request);
    await resolve(String(request._id), 'Trip cancelled');
    await resolve(`${request._id}-issue`, 'Trip cancelled');
  }
  if (trip.get('nominationId')) await Nomination.updateOne({ _id: trip.get('nominationId') }, { $pull: { tripIds: trip._id }, $inc: { version: 1 } });
  if (trip.get('driverId')) await post(driverThread(trip.get('driverId')), at, { text: `${trip.get('number')} is cancelled. ${input.reason}` }, ctx);
  await log(ctx, at, `Cancelled: ${input.reason}`, { tripId: trip._id });
  return presentTrip(trip.toObject());
}

/* ---------- Funding suggestion ---------- */

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
  const room = truck.tankL ? Math.max(0, truck.tankL - truck.fuelL - fuelOpen) : Number.MAX_SAFE_INTEGER;
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

export async function dispatchTrip(id: string, ctx: OpsContext) {
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
  const issued = (await FundRequest.find({ tripId: trip._id, kind: 'fuel', status: 'issued' }).lean()).reduce((s, r) => s + Number(r.litres ?? 0), 0);
  const stops = trip.get('stops');
  stops[0].arrivedAt ??= at;
  stops[0].leftAt = at;
  recordEvent(trip, 'dispatched', at, ctx.actorId);
  trip.set({ dispatchedAt: at, openingFuelL: Math.max(0, round(truck.fuelL - issued, 0)), tracking: { km: 0, speed: 0, heading: 0, at }, updatedBy: ctx.actorId });
  await save(trip);
  await resolve(`${trip._id}-dispatch`, 'Dispatched');
  const plain = trip.toObject() as Plain;
  const base = await baseCurrency();
  const holds = Math.max(0, await carriedIn(plain.driverId, trip._id)) + (await FundRequest.find({ tripId: trip._id, kind: 'cash', status: 'issued' }).lean()).reduce((s, r) => s + Number(r.baseAmountMinor ?? 0), 0);
  const plainStops = plain.stops as Array<{ kind: string; placeId: unknown }>;
  await post(driverThread(plain.driverId), at, {
    title: `On your way · ${plain.number}`,
    text: `Head to ${await placeName(plainStops.find((s) => s.kind === 'load')?.placeId)} for loading. Offload at ${await placeName(plainStops.find((s) => s.kind === 'offload')?.placeId)}.`,
    rows: [
      ['Truck', `${truck.plate}${plain.trailerId ? ` · ${await trailerPlate(plain.trailerId)}` : ''}`],
      ['Fuel in tank', litres(truck.fuelL)],
      ['Cash with you', formatMoney(holds, base)],
    ],
  }, ctx);
  await log(ctx, at, `Dispatched from ${await placeName(plainStops[0]?.placeId)}`, { tripId: trip._id });
  return presentTrip(plain);
}

/** Messages when a truck reaches a loading point, an offloading point or the end. */
async function announceArrival(trip: Plain, index: number, at: Date, ctx: OpsContext) {
  const stops = trip.stops as Array<{ kind: string; placeId: unknown }>;
  const stop = stops[index]!;
  const place = await placeName(stop.placeId);
  const driver = trip.driverId ? await driverName(trip.driverId) : '';
  if (stop.kind === 'load' || stop.kind === 'offload') {
    const loading = stop.kind === 'load';
    await log(ctx, at, `Reached ${place} for ${loading ? 'loading' : 'offloading'}`, { tripId: trip._id });
    if (trip.driverId) {
      await post(driverThread(trip.driverId), at, {
        title: `You've reached ${place}`,
        text: loading ? 'Send a photo of the loading invoice once the tanker is filled and sealed.' : 'Send the signed delivery note with the offloading readings.',
        buttons: [{ label: loading ? 'Send loading invoice' : 'Send delivery note', attach: loading ? 'loading' : 'delivery', tone: 'primary' }],
        refId: `${trip._id}-${loading ? 'loading' : 'delivery'}`,
      }, ctx);
    }
    await post(queue('consignments'), at, {
      title: `${trip.number} reached ${place}`,
      text: `${firstName(driver)} will send the ${loading ? 'loading invoice' : 'delivery note'}.`,
      buttons: [{ label: 'Open trip', nav: { tripId: String(trip._id) } }],
    }, ctx);
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

/** Stamps arrival at a stop (and the stops passed before it) and sends the messages for it. */
export async function arriveAt(trip: HydratedDocument<any>, index: number, at: Date, ctx: OpsContext, quiet = false) {
  const stamped = stampArrival(trip.get('stops'), index, at);
  if (stamped && trip.get('stops')[index]?.kind === 'offload') recordEvent(trip, 'arrived_offloading', at, ctx.actorId);
  if (stamped && !quiet) await announceArrival(trip.toObject() as Plain, index, at, ctx);
}

/** A position report: kilometres along the route. The truck can't pass loading before the load is recorded, or offloading before delivery. */
export async function reportPosition(id: string, input: S.PositionInput, ctx: OpsContext) {
  need(ctx, 'trips', 'update');
  const at = new Date();
  const trip = await tripDoc(id);
  if (!trip.get('dispatchedAt') || !activeTrip(trip.toObject())) throw conflict('Dispatch the trip to start tracking.');
  const stops = trip.get('stops') as Array<{ kind: string; legKm: number; arrivedAt?: Date; leftAt?: Date }>;
  const cum = cumulativeKm(stops);
  const end = cum.at(-1) ?? 0;
  const previous = Number(trip.get('tracking')?.km ?? 0);
  let km = Math.max(previous, Math.min(input.km, end));
  const loadIndex = stops.findIndex((s) => s.kind === 'load');
  const offloadIndex = stops.findIndex((s) => s.kind === 'offload');
  const consignments = await Consignment.find({ tripId: trip._id }).select('delivered').lean();
  if (!consignments.length) km = Math.min(km, cum[loadIndex]!);
  else if (consignments.some((c) => !c.delivered)) km = Math.min(km, cum[offloadIndex]!);
  const held = km < Math.min(input.km, end) - 0.01;
  const delivered = consignments.length > 0 && consignments.every((c) => c.delivered);
  const arrivals: number[] = [];
  stops.forEach((stop, index) => {
    if (index > offloadIndex && !delivered) return;
    if (index > 0 && !stop.arrivedAt && km >= cum[index]! - 0.01) arrivals.push(index);
  });
  for (const index of arrivals) await arriveAt(trip, index, at, ctx);
  stops.forEach((stop, index) => {
    if (stop.arrivedAt && !stop.leftAt && km > cum[index]! + 0.5) {
      const back = input.speed > 0 ? ((km - cum[index]!) / input.speed) * 36e5 : 0;
      stop.leftAt = new Date(Math.max(stop.arrivedAt.getTime(), at.getTime() - back));
    }
  });
  const parked = stops.some((s, i) => s.kind !== 'via' && s.kind !== 'border' && s.kind !== 'start' && s.arrivedAt && !s.leftAt && Math.abs(cum[i]! - km) < 0.5);
  trip.set('tracking', { km, speed: km > previous && !held && !parked ? input.speed : 0, heading: km > previous ? input.heading ?? 0 : Number(trip.get('tracking')?.heading ?? 0), at });
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
  const loadIndex = stops.findIndex((s) => s.kind === 'load');
  if (index > loadIndex && !(await Consignment.exists({ tripId: trip._id }))) throw refuse('Record the loading first.');
  trip.set('tracking', { ...(trip.get('tracking')?.toObject?.() ?? { heading: 0 }), km: cumulativeKm(stops)[index], speed: 0, at });
  await arriveAt(trip, index, at, ctx);
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
  const loaded = await Consignment.exists({ tripId: trip._id });
  await post(driverThread(trip.driverId), at, {
    title: `Reminder · ${trip.number}`,
    text: 'Operations is waiting for your document.',
    buttons: [{ label: 'Send it now', tone: 'primary', attach: loaded ? 'delivery' : 'loading' }],
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
  const consignments = await Consignment.find({ tripId: trip._id }).select('delivered').lean();
  if (!consignments.length) throw refuse('Nothing was loaded on this trip.');
  if (consignments.some((c) => !c.delivered)) throw refuse('Record the delivery first.');
  const truck = await truckFacts(trip.get('vehicleId'), false);
  if (truck.tankL && input.closingFuelL > truck.tankL) throw refuse(`The tank holds ${litres(truck.tankL)}.`);
  const stops = trip.get('stops') as Array<{ placeId: unknown; legKm: number; leftAt?: Date }>;
  for (let i = 0; i < stops.length; i += 1) stampArrival(stops, i, at);
  stops.at(-1)!.leftAt = undefined;
  const endPlace = stops.at(-1)!.placeId;
  recordEvent(trip, 'ended', at, ctx.actorId);
  trip.set({ endedAt: at, closingFuelL: input.closingFuelL, active: false, tracking: { ...(trip.get('tracking')?.toObject?.() ?? { heading: 0 }), km: tripKm(stops), speed: 0, at }, updatedBy: ctx.actorId });
  trip.markModified('stops');
  await save(trip);
  await setVehicleState(trip.get('vehicleId'), { placeId: endPlace, fuelL: input.closingFuelL }, ctx.actorId);
  await resolve(`${trip._id}-end`, 'Trip ended');
  const plain = trip.toObject() as Plain;
  const place = await placeName(endPlace);
  if (plain.driverId) {
    const name = await driverName(plain.driverId);
    const unsettled = await Trip.countDocuments({ driverId: plain.driverId, endedAt: { $exists: true }, settlementId: { $exists: false } });
    const base = await baseCurrency();
    await post(driverThread(plain.driverId), at, { title: `${plain.number} closed`, text: `Truck parked at ${place} with ${litres(input.closingFuelL)}. Thank you.` }, ctx);
    await post(queue('settlements'), at, {
      title: `${plain.number} ended`,
      text: `${name} has ${unsettled} trip${unsettled > 1 ? 's' : ''} to settle. Balance ${formatMoney(await driverBalance(plain.driverId), base)}.`,
      buttons: [{ label: 'Open statement', tone: 'primary', nav: { view: 'settle', driverId: String(plain.driverId) } }],
    }, ctx);
  }
  const label = await routeLabel(plain as never);
  await post(queue('trips'), at, { title: `Trip sheet ready · ${plain.number}`, text: `${label}, ${Math.round(tripKm(stops)).toLocaleString('en-GB')} km. ${truck.plate} is free at ${place}.`, buttons: [{ label: 'View trip sheet', nav: { tripId: String(plain._id), view: 'sheet' } }] }, ctx);
  await log(ctx, at, `Ended at ${place} · ${litres(input.closingFuelL)} in the tank`, { tripId: trip._id });
  return presentTrip(plain);
}

