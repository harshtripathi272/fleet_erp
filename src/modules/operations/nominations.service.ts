import { NotFoundError } from '../../core/errors/index.js';
import type { Plain } from '../../core/masters/types.js';
import { Product } from '../cargo/models/product.model.js';
import { Driver } from '../drivers/models/driver.model.js';
import { Vehicle } from '../fleet/models/vehicle.model.js';
import { Place } from '../geography/models/place.model.js';
import { Route } from '../geography/models/route.model.js';
import { OrderSource } from '../parties/models/orderSource.model.js';
import { Nomination } from './models/money.model.js';
import { Trip } from './models/trip.model.js';
import { announce } from './notices.js';
import {
  activeDriver, activeRecord, conflict, customerParty, customerThread, loadOr404, log, need, nextNumber, post, present, queue, refuse, resolve,
  save, shortDate, type OpsContext,
} from './support.js';
import { createTrip, driverName, placeName, stopsFromTruck, truckFacts } from './trips.service.js';
import type * as S from './operations.schema.js';
import { operationsSettings } from './settings.js';

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export async function listNominations(query: S.NominationListQuery) {
  const filter: Plain = {};
  if (query.status) filter.status = query.status;
  if (query.customerId) filter.customerId = query.customerId;
  const [rows, total] = await Promise.all([
    Nomination.find(filter).sort({ createdAt: -1, _id: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
    Nomination.countDocuments(filter),
  ]);
  return { data: rows.map(present), total, page: query.page, limit: query.limit };
}

export async function getNomination(id: string) {
  const doc = await Nomination.findById(id).lean();
  if (!doc) throw new NotFoundError('Nomination not found');
  return present(doc);
}

async function checkNomination(input: S.NominationInput) {
  const customer = await customerParty(input.customerId);
  await activeRecord(Place, input.loadingPlaceId, 'loading site');
  if (input.productId) await activeRecord(Product, input.productId, 'product');
  if (input.orderSourceId) {
    const source = await activeRecord(OrderSource, input.orderSourceId, 'order source');
    if (source.referenceRequired && !input.reference) throw refuse(`Add the reference number (${source.name}).`);
  }
  const vehicles = new Set(input.trucks.map((t) => t.vehicleId));
  if (vehicles.size !== input.trucks.length) throw refuse('Each truck can appear once.');
  for (const t of input.trucks) {
    await activeRecord(Vehicle, t.vehicleId, 'truck');
    if (t.driverId) await activeDriver(t.driverId);
  }
  return customer;
}

export async function createNomination(input: S.NominationInput, ctx: OpsContext) {
  need(ctx, 'nominations', 'create');
  const at = new Date();
  const customer = await checkNomination(input);
  const nomination = new Nomination({ ...input, number: await nextNumber('nominations', 'NOM', at), status: 'draft', createdBy: ctx.actorId, updatedBy: ctx.actorId });
  await save(nomination);
  await log(ctx, at, `${nomination.get('number')} for ${customer.name}: ${count(input.trucks.length, 'truck')}`, { entity: 'nominations', entityId: nomination._id });
  return present(nomination.toObject());
}

export async function updateNomination(id: string, input: S.NominationUpdateInput, ctx: OpsContext) {
  need(ctx, 'nominations', 'update');
  const at = new Date();
  const nomination = await loadOr404(Nomination, id, 'Nomination');
  if (nomination.get('version') !== input.version) throw conflict('This nomination was changed by someone else. Reload it and try again.');
  if (!['draft', 'sent'].includes(nomination.get('status'))) throw conflict(nomination.get('status') === 'converted' ? 'This nomination already has trips.' : 'This nomination can no longer be edited.');
  const { version: _version, ...changes } = input;
  const customer = await checkNomination({ ...(nomination.toObject() as S.NominationInput), ...changes } as S.NominationInput);
  nomination.set({ ...changes, updatedBy: ctx.actorId });
  await save(nomination);
  await log(ctx, at, `${nomination.get('number')} for ${customer.name}: ${count(nomination.get('trucks').length, 'truck')}`, { entity: 'nominations', entityId: nomination._id });
  return present(nomination.toObject());
}

/** Sends the nomination to the customer with each truck and its driver. */
export async function sendNomination(id: string, ctx: OpsContext) {
  need(ctx, 'nominations', 'update');
  const at = new Date();
  const nomination = await loadOr404(Nomination, id, 'Nomination');
  if (!['draft', 'sent'].includes(nomination.get('status'))) throw conflict('This nomination was already answered.');
  const customer = await customerParty(nomination.get('customerId'));
  nomination.set({ status: 'sent', sentAt: at, updatedBy: ctx.actorId });
  await save(nomination);
  const n = nomination.toObject() as Plain;
  const rows: Array<[string, string]> = [];
  for (const t of n.trucks as Array<{ vehicleId: unknown; driverId?: unknown }>) {
    const vehicle = await Vehicle.findById(t.vehicleId).select('registrationNumber').lean();
    const driver = (t.driverId ? await Driver.findById(t.driverId) : await Driver.findOne({ assignedVehicleId: t.vehicleId, status: 'active' }))?.toObject() as Plain | undefined;
    rows.push([String(vehicle?.registrationNumber ?? ''), driver ? `${driver.name} · ${driver.phone}` : 'Driver to confirm']);
  }
  await post(customerThread(customer._id), at, {
    from: 'me', title: `Nomination ${n.number}`,
    text: `${count(rows.length, 'truck')} for loading at ${await placeName(n.loadingPlaceId)} on ${shortDate(n.requiredDate as Date)}. Tracking links go live at dispatch.`,
    rows, refId: String(n._id),
  }, ctx);
  await log(ctx, at, `${n.number} sent to ${customer.name}`, { entity: 'nominations', entityId: n._id });
  await announce('nomination.sent', null, ctx, {
    partyId: customer._id,
    variables: {
      'vehicle.registration': rows.map(([plate]) => plate).filter(Boolean).join(', '),
      'place.name': await placeName(n.loadingPlaceId), 'document.number': String(n.number), date: shortDate(n.requiredDate as Date),
    },
    ref: { kind: 'nominations', id: n._id },
  });
  return present(n);
}

/** The customer accepted: recorded by the office, or a reply on the customer's thread. */
export async function acceptNomination(id: string, input: S.AcceptInput, ctx: OpsContext) {
  need(ctx, 'nominations', 'update');
  const at = new Date();
  const nomination = await loadOr404(Nomination, id, 'Nomination');
  if (nomination.get('status') !== 'sent') throw conflict('Send the nomination first.');
  nomination.set({ status: 'accepted', acceptedAt: at, updatedBy: ctx.actorId });
  await save(nomination);
  const n = nomination.toObject() as Plain;
  const customer = await customerParty(n.customerId);
  const trucks = (n.trucks as unknown[]).length;
  if (input.customerReply) await post(customerThread(customer._id), at, { from: 'contact', text: trucks === 1 ? 'Accepted, thank you. Please proceed.' : `Accepted, thank you. Please proceed with all ${trucks} trucks.` }, ctx);
  await post(queue('nominations'), at, {
    title: `${customer.name} accepted ${n.number}`, text: trucks === 1 ? 'Create the trip.' : `Create the ${trucks} trips.`,
    buttons: [{ label: 'Create trips', tone: 'primary', nav: { view: 'nominations' } }], refId: `${n._id}-accepted`,
  }, ctx);
  await log(ctx, at, `${customer.name} accepted ${n.number}`, { entity: 'nominations', entityId: n._id });
  return present(n);
}

/** One trip per truck, starting where each truck is now, loading at the nomination's site. */
export async function convertNomination(id: string, input: S.ConvertInput, ctx: OpsContext) {
  need(ctx, 'trips', 'create');
  need(ctx, 'nominations', 'update');
  const nomination = await loadOr404(Nomination, id, 'Nomination');
  if (nomination.get('status') !== 'accepted') throw conflict("The customer hasn't accepted yet.");
  if (!input.routeId && !input.offloadPlaceId) throw refuse('Choose the route or the offloading point.');
  const route = input.routeId ? await activeRecord(Route, input.routeId, 'route') : null;
  if (input.offloadPlaceId) await activeRecord(Place, input.offloadPlaceId, 'offloading point');
  const n = nomination.toObject() as Plain;
  const trucks = n.trucks as Array<{ vehicleId: unknown; driverId?: unknown }>;
  const { tripStartsFromTruck } = await operationsSettings();
  // Check every truck before creating any trip, so a busy truck doesn't leave half the nomination converted.
  const plans = [];
  for (const item of trucks) {
    const truck = await truckFacts(item.vehicleId);
    const driverId = item.driverId ?? (await Driver.findOne({ assignedVehicleId: item.vehicleId, status: 'active' }).select('_id').lean())?._id;
    const trailerId = truck.vehicle.currentTrailerId;
    if (await Trip.exists({ vehicleId: item.vehicleId, active: true })) throw conflict(`${truck.plate} is already on a trip.`);
    if (driverId && (await Trip.exists({ driverId, active: true }))) throw conflict(`${await driverName(driverId)} is already on a trip.`);
    if (trailerId && (await Trip.exists({ trailerId, active: true }))) throw conflict(`The trailer of ${truck.plate} is already on a trip.`);
    if (tripStartsFromTruck && !truck.placeId) throw refuse(`Set where ${truck.plate} is before creating its trip.`);
    const start = (tripStartsFromTruck ? truck.placeId : undefined) ?? String(n.loadingPlaceId);
    const base = route
      ? (route.stops as Array<{ placeId: unknown; kind: string }>).map((s) => ({ placeId: s.kind === 'load' ? String(n.loadingPlaceId) : String(s.placeId), kind: s.kind }))
      : [{ placeId: start, kind: 'start' }, { placeId: String(n.loadingPlaceId), kind: 'load' }, { placeId: input.offloadPlaceId!, kind: 'offload' }, { placeId: input.offloadPlaceId!, kind: 'end' }];
    plans.push({ vehicleId: String(item.vehicleId), driverId: driverId ? String(driverId) : undefined, trailerId: trailerId ? String(trailerId) : undefined, stops: tripStartsFromTruck ? stopsFromTruck(base, truck.placeId) : base });
  }
  const tripIds = [];
  for (const plan of plans) {
    const trip = await createTrip({
      customerId: String(n.customerId), vehicleId: plan.vehicleId, driverId: plan.driverId, trailerId: plan.trailerId, routeId: route ? String(route._id) : undefined,
      stops: plan.stops as S.CreateTripInput['stops'], plannedStart: new Date(`${(n.requiredDate as Date).toISOString().slice(0, 10)}T06:00:00.000Z`),
      productId: n.productId ? String(n.productId) : undefined, plannedQty: n.qtyPerTruck as number | undefined,
    }, ctx, { nominationId: n._id });
    tripIds.push(String(trip.id));
  }
  nomination.set({ status: 'converted', tripIds, updatedBy: ctx.actorId });
  await save(nomination);
  await resolve(`${n._id}-accepted`, 'Trips created');
  return present(nomination.toObject());
}

export async function cancelNomination(id: string, ctx: OpsContext) {
  need(ctx, 'nominations', 'update');
  const at = new Date();
  const nomination = await loadOr404(Nomination, id, 'Nomination');
  if (nomination.get('status') === 'converted') throw conflict('Cancel its trips instead.');
  if (nomination.get('status') === 'cancelled') throw conflict('Already cancelled.');
  nomination.set({ status: 'cancelled', updatedBy: ctx.actorId });
  await save(nomination);
  await log(ctx, at, `${nomination.get('number')} cancelled`, { entity: 'nominations', entityId: nomination._id });
  return present(nomination.toObject());
}
