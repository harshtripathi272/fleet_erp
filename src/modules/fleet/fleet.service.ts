import { Types } from 'mongoose';
import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors/index.js';
import { audit } from '../../core/masters/audit.js';
import { defineMaster } from '../../core/masters/define.js';
import { GROUPS } from '../../core/masters/groups.js';
import { boolQuery, idQuery } from '../../core/masters/query.js';
import { duplicateKeyError, serialize, type ServiceContext } from '../../core/masters/service.js';
import type { MasterDefinition, Plain } from '../../core/masters/types.js';
import * as S from './fleet.schema.js';
import { Pairing } from './models/pairing.model.js';
import { Trailer } from './models/trailer.model.js';
import { CARGO_KINDS, TrailerType } from './models/trailerType.model.js';
import { OPERATIONAL_STATUSES, Vehicle } from './models/vehicle.model.js';
import { VehicleMake } from './models/vehicleMake.model.js';
import { VehicleModel } from './models/vehicleModel.model.js';
import { VEHICLE_CATEGORIES, VehicleType } from './models/vehicleType.model.js';

const byId = (field: string) => ({ schema: idQuery, apply: (v: string) => ({ [field]: new Types.ObjectId(v) }), description: `Only records with this ${field}` });
const plateKey = (plate: unknown) => String(plate ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const fail = (errors: Record<string, string[]>) => { if (Object.keys(errors).length) throw new ValidationError('Details are not valid', errors); };
const push = (errors: Record<string, string[]>, key: string, message: string) => { (errors[key] ??= []).push(message); };

export const vehicleMakeDefinition = defineMaster({
  key: 'vehicle-makes', label: 'Vehicle makes', singular: 'Vehicle make', group: GROUPS.fleet,
  description: 'Manufacturers: Scania, Volvo, MAN, Mercedes-Benz, Howo…',
  model: VehicleMake, createSchema: S.createVehicleMakeSchema, updateSchema: S.updateVehicleMakeSchema,
  refs: [{ path: 'countryId', target: 'countries' }],
});

function checkConsumption(data: Plain, errors: Record<string, string[]>) {
  if (typeof data.kmPerLLoaded === 'number' && typeof data.kmPerLEmpty === 'number' && data.kmPerLLoaded > data.kmPerLEmpty) {
    push(errors, 'kmPerLLoaded', 'A loaded truck cannot cover more km per litre than an empty one');
  }
}

export const vehicleModelDefinition = defineMaster({
  key: 'vehicle-models', label: 'Vehicle models', singular: 'Vehicle model', group: GROUPS.fleet,
  description: 'Specifications shared by every truck of a model: axle configuration, masses, tank size and default fuel consumption.',
  model: VehicleModel, createSchema: S.createVehicleModelSchema, updateSchema: S.updateVehicleModelSchema,
  refs: [{ path: 'makeId', target: 'vehicle-makes' }, { path: 'vehicleTypeId', target: 'vehicle-types' }],
  filters: { makeId: byId('makeId') },
  async prepare(data: Plain) {
    const errors: Record<string, string[]> = {};
    checkConsumption(data, errors);
    if (typeof data.grossVehicleMassKg === 'number' && typeof data.grossCombinationMassKg === 'number' && data.grossCombinationMassKg < data.grossVehicleMassKg) {
      push(errors, 'grossCombinationMassKg', 'Combination mass cannot be below the vehicle mass');
    }
    fail(errors);
    return data;
  },
});

export const vehicleTypeDefinition = defineMaster({
  key: 'vehicle-types', label: 'Vehicle types', singular: 'Vehicle type', group: GROUPS.fleet,
  description: 'Horse, rigid, tipper, light vehicle. Says which licence classes may drive it, whether it tows a trailer, and which documents it needs.',
  model: VehicleType, createSchema: S.createVehicleTypeSchema, updateSchema: S.updateVehicleTypeSchema,
  refs: [{ path: 'licenceClassIds', target: 'licence-classes' }, { path: 'requiredDocumentTypeIds', target: 'document-types' }],
  filters: {
    category: { schema: z.enum(VEHICLE_CATEGORIES), apply: (v: string) => ({ category: v }), description: 'Category' },
    towsTrailer: { schema: boolQuery, apply: (v: boolean) => ({ towsTrailer: v }), description: 'Tows a trailer' },
  },
  async prepare(data: Plain, ctx) {
    if (ctx.mode === 'update' && ctx.existing?.towsTrailer && data.towsTrailer === false && ctx.id) {
      const paired = await Pairing.countDocuments({ open: true, vehicleId: { $in: (await Vehicle.find({ vehicleTypeId: ctx.id }).select('_id').lean()).map((v) => v._id) } });
      if (paired) throw new ConflictError(`${paired} truck(s) of this type are paired with trailers. End those pairings first.`);
    }
    return data;
  },
});

export const vehicleDefinition = defineMaster({
  key: 'vehicles', label: 'Vehicles', singular: 'Vehicle', group: GROUPS.fleet,
  description: 'Each truck: plate, chassis and engine numbers, make and model, ownership, fuel figures, purchase and sale. The current trailer is maintained by pairing.',
  model: Vehicle, createSchema: S.createVehicleSchema, updateSchema: S.updateVehicleSchema,
  searchFields: ['code', 'registrationNumber', 'registrationKey', 'vin', 'engineNumber', 'gpsDeviceId'],
  sortFields: ['code', 'registrationNumber', 'year', 'odometerKm', 'createdAt', 'updatedAt'],
  titleField: 'registrationNumber',
  hidden: ['registrationKey'],
  refs: [
    { path: 'makeId', target: 'vehicle-makes' }, { path: 'modelId', target: 'vehicle-models' }, { path: 'vehicleTypeId', target: 'vehicle-types' },
    { path: 'ownerPartyId', target: 'parties', partyRoles: ['hired_transporter', 'financier', 'dealer'] },
    { path: 'financierPartyId', target: 'parties', partyRoles: ['financier'] },
    { path: 'dealerPartyId', target: 'parties', partyRoles: ['dealer'] },
    { path: 'homeBranchId', target: 'branches' }, { path: 'fuelTypeId', target: 'fuel-types' },
    { path: 'purchase.amount.currencyId', target: 'currencies' }, { path: 'sale.amount.currencyId', target: 'currencies' },
    { path: 'currentTrailerId', target: 'trailers' },
  ],
  filters: {
    vehicleTypeId: byId('vehicleTypeId'), homeBranchId: byId('homeBranchId'), makeId: byId('makeId'),
    operationalStatus: { schema: z.enum(OPERATIONAL_STATUSES), apply: (v: string) => ({ operationalStatus: v }), description: 'Operational status' },
    paired: { schema: boolQuery, apply: (v: boolean) => (v ? { currentTrailerId: { $exists: true } } : { currentTrailerId: { $exists: false } }), description: 'Currently paired with a trailer' },
  },
  async prepare(data: Plain, ctx) {
    const errors: Record<string, string[]> = {};
    checkConsumption(data, errors);
    if (data.modelId) {
      const model = await VehicleModel.findById(data.modelId).select('makeId').lean();
      if (model && String(model.makeId) !== String(data.makeId)) push(errors, 'modelId', 'This model belongs to a different make');
    }
    const ownership = data.ownership ?? 'own';
    if (ownership === 'own' && data.ownerPartyId) push(errors, 'ownerPartyId', 'Own trucks have no external owner');
    if (ownership !== 'own' && !data.ownerPartyId) push(errors, 'ownerPartyId', `${ownership === 'hired' ? 'Hired' : 'Leased'} trucks need the owning party`);
    const purchase = data.purchase as { date: Date } | undefined;
    const sale = data.sale as { date: Date } | undefined;
    if (purchase && sale && sale.date < purchase.date) push(errors, 'sale', 'Sale date is before the purchase date');
    if (sale && data.operationalStatus !== 'sold') push(errors, 'operationalStatus', 'A truck with a sale record must have status "sold"');
    if (data.operationalStatus === 'sold' && !sale) push(errors, 'sale', 'Record the sale date before marking the truck as sold');
    if (data.registrationDate instanceof Date && data.registrationDate > new Date(Date.now() + 86400000)) push(errors, 'registrationDate', 'Cannot be in the future');
    if (ctx.mode === 'update' && typeof ctx.existing?.odometerKm === 'number' && typeof data.odometerKm === 'number' && data.odometerKm < ctx.existing.odometerKm) {
      push(errors, 'odometerKm', `Odometer cannot go back from ${ctx.existing.odometerKm} km`);
    }
    if (data.operationalStatus === 'sold' && data.currentTrailerId) push(errors, 'operationalStatus', 'End the trailer pairing before marking the truck as sold');
    fail(errors);
    return { ...data, registrationKey: plateKey(data.registrationNumber) };
  },
});

export const trailerTypeDefinition = defineMaster({
  key: 'trailer-types', label: 'Trailer types', singular: 'Trailer type', group: GROUPS.fleet,
  description: 'Tanker, flatbed, tautliner, skeletal, side-tipper, lowbed, reefer: which cargo each carries and whether it has compartments.',
  model: TrailerType, createSchema: S.createTrailerTypeSchema, updateSchema: S.updateTrailerTypeSchema,
  refs: [{ path: 'requiredDocumentTypeIds', target: 'document-types' }],
  filters: { cargoKind: { schema: z.enum(CARGO_KINDS), apply: (v: string) => ({ cargoKinds: v }), description: 'Carries this kind of cargo' } },
  async prepare(data: Plain, ctx) {
    if (ctx.mode === 'update' && ctx.existing?.hasCompartments !== data.hasCompartments && ctx.id) {
      const count = await Trailer.countDocuments({ trailerTypeId: ctx.id, status: { $ne: 'archived' } });
      if (count) throw new ConflictError(`${count} trailer(s) use this type; changing compartments would invalidate them`);
    }
    return data;
  },
});

export const trailerDefinition = defineMaster({
  key: 'trailers', label: 'Trailers', singular: 'Trailer', group: GROUPS.fleet,
  description: 'Each trailer with capacity and, for tankers, compartment capacities (their sum cannot exceed the trailer capacity).',
  model: Trailer, createSchema: S.createTrailerSchema, updateSchema: S.updateTrailerSchema,
  searchFields: ['code', 'registrationNumber', 'registrationKey', 'chassisNumber'],
  sortFields: ['code', 'registrationNumber', 'year', 'createdAt', 'updatedAt'],
  titleField: 'registrationNumber',
  hidden: ['registrationKey'],
  refs: [
    { path: 'trailerTypeId', target: 'trailer-types' }, { path: 'ownerPartyId', target: 'parties', partyRoles: ['hired_transporter', 'financier', 'dealer'] },
    { path: 'homeBranchId', target: 'branches' }, { path: 'currentVehicleId', target: 'vehicles' },
  ],
  filters: {
    trailerTypeId: byId('trailerTypeId'), homeBranchId: byId('homeBranchId'),
    operationalStatus: { schema: z.enum(OPERATIONAL_STATUSES), apply: (v: string) => ({ operationalStatus: v }), description: 'Operational status' },
    paired: { schema: boolQuery, apply: (v: boolean) => (v ? { currentVehicleId: { $exists: true } } : { currentVehicleId: { $exists: false } }), description: 'Currently paired with a truck' },
  },
  async prepare(data: Plain) {
    const errors: Record<string, string[]> = {};
    const type = await TrailerType.findById(data.trailerTypeId).select('hasCompartments').lean();
    const compartments = (data.compartments ?? []) as Array<{ number: number; capacityL: number }>;
    if (type?.hasCompartments && !compartments.length) push(errors, 'compartments', 'This trailer type has compartments; list them');
    if (type && !type.hasCompartments && compartments.length) push(errors, 'compartments', 'This trailer type has no compartments');
    const numbers = compartments.map((c) => c.number);
    if (new Set(numbers).size !== numbers.length) push(errors, 'compartments', 'Compartment numbers must be unique');
    const total = compartments.reduce((sum, c) => sum + c.capacityL, 0);
    let capacityL = data.capacityL as number | undefined;
    if (compartments.length) {
      if (capacityL === undefined) capacityL = total;
      else if (total > capacityL + 0.001) push(errors, 'compartments', `Compartments hold ${total} L but the trailer capacity is ${capacityL} L`);
    }
    if (capacityL === undefined && data.capacityKg === undefined) push(errors, 'capacityKg', 'Give a capacity in kg or litres');
    const ownership = data.ownership ?? 'own';
    if (ownership === 'own' && data.ownerPartyId) push(errors, 'ownerPartyId', 'Own trailers have no external owner');
    if (ownership !== 'own' && !data.ownerPartyId) push(errors, 'ownerPartyId', 'Hired or leased trailers need the owning party');
    fail(errors);
    return { ...data, capacityL, registrationKey: plateKey(data.registrationNumber) };
  },
});

export const pairingDefinition = defineMaster({
  key: 'pairings', label: 'Truck–trailer pairings', singular: 'Pairing', group: GROUPS.fleet,
  description: 'Which trailer runs with which truck, with full history. Use Pair and End; a truck and a trailer can each be in only one open pairing. Ended pairings are kept as archived history (list with status=all).',
  // Created by POST /pairings with pairSchema (the screens build their form from it); never edited, only ended.
  model: Pairing, createSchema: S.pairSchema, updateSchema: S.pairingPlaceholderSchema,
  searchFields: ['reason', 'endReason'], sortFields: ['from', 'to', 'createdAt'], defaultSort: '-from', titleField: 'from',
  refs: [{ path: 'vehicleId', target: 'vehicles' }, { path: 'trailerId', target: 'trailers' }],
  managed: { create: true, update: true, delete: true, archive: true },
  customFields: false,
  filters: {
    vehicleId: byId('vehicleId'), trailerId: byId('trailerId'),
    open: { schema: boolQuery, apply: (v: boolean) => ({ open: v }), description: 'Open (current) pairings only' },
  },
});

/** Re-derives currentTrailerId / currentVehicleId from open pairings (idempotent). */
async function syncCurrent(vehicleIds: unknown[], trailerIds: unknown[]) {
  for (const id of new Set(vehicleIds.map(String))) {
    const open = await Pairing.findOne({ vehicleId: id, open: true }).select('trailerId').lean();
    await Vehicle.updateOne({ _id: id }, open ? { $set: { currentTrailerId: open.trailerId } } : { $unset: { currentTrailerId: 1 } });
  }
  for (const id of new Set(trailerIds.map(String))) {
    const open = await Pairing.findOne({ trailerId: id, open: true }).select('vehicleId').lean();
    await Trailer.updateOne({ _id: id }, open ? { $set: { currentVehicleId: open.vehicleId } } : { $unset: { currentVehicleId: 1 } });
  }
}

export async function pair(input: { vehicleId: string; trailerId: string; from?: Date; reason?: string }, ctx: ServiceContext) {
  const from = input.from ?? new Date();
  if (from > new Date(Date.now() + 86400000)) throw new ValidationError('A pairing cannot start in the future', { from: ['In the future'] });
  const [vehicle, trailer] = await Promise.all([
    Vehicle.findById(input.vehicleId).select('status operationalStatus vehicleTypeId registrationNumber').lean(),
    Trailer.findById(input.trailerId).select('status operationalStatus registrationNumber').lean(),
  ]);
  if (!vehicle || vehicle.status !== 'active') throw new ValidationError('No active vehicle with this id', { vehicleId: ['Not found or inactive'] });
  if (!trailer || trailer.status !== 'active') throw new ValidationError('No active trailer with this id', { trailerId: ['Not found or inactive'] });
  if (vehicle.operationalStatus === 'sold' || trailer.operationalStatus === 'sold') throw new ConflictError('Sold vehicles and trailers cannot be paired');
  const type = await VehicleType.findById(vehicle.vehicleTypeId).select('towsTrailer name').lean();
  if (!type?.towsTrailer) throw new ConflictError(`${vehicle.registrationNumber} is a ${type?.name ?? 'vehicle'} type that does not tow trailers`);

  const current = await Pairing.find({ open: true, $or: [{ vehicleId: input.vehicleId }, { trailerId: input.trailerId }] }).lean();
  if (current.some((p) => String(p.vehicleId) === input.vehicleId && String(p.trailerId) === input.trailerId)) {
    throw new ConflictError('This truck and trailer are already paired');
  }
  for (const p of current) {
    // With no start given, "now" can fall a moment before a pairing another request has just made: that is a clash, not a bad date.
    if (from < (p.from as Date) && !input.from) throw new ConflictError('Another pairing for this truck or trailer was just created. Reload and try again.');
    if (from < (p.from as Date)) throw new ValidationError('The new pairing starts before an existing one began', { from: [`Must be on or after ${(p.from as Date).toISOString()}`] });
  }
  for (const p of current) {
    await Pairing.updateOne({ _id: p._id, open: true }, { $set: { open: false, to: from, endReason: 'Replaced by a new pairing', status: 'archived', archivedAt: new Date(), updatedBy: ctx.actorId }, $inc: { version: 1 } });
    await audit({ entity: 'pairings', entityId: p._id, action: 'update', summary: 'Ended by a new pairing', actorId: ctx.actorId, requestId: ctx.requestId });
  }
  try {
    const created = await Pairing.create({ vehicleId: input.vehicleId, trailerId: input.trailerId, from, reason: input.reason, createdBy: ctx.actorId, updatedBy: ctx.actorId });
    await audit({ entity: 'pairings', entityId: created._id, action: 'create', summary: `Paired ${vehicle.registrationNumber} with ${trailer.registrationNumber}`, actorId: ctx.actorId, requestId: ctx.requestId });
    return serialize(pairingDefinition, created.toObject() as Plain);
  } catch (err) {
    const dup = duplicateKeyError(err);
    if (dup) throw new ConflictError('Another pairing for this truck or trailer was just created. Reload and try again.');
    throw err;
  } finally {
    await syncCurrent([input.vehicleId, ...current.map((p) => p.vehicleId)], [input.trailerId, ...current.map((p) => p.trailerId)]);
  }
}

export async function endPairing(id: string, input: { to?: Date; reason?: string }, ctx: ServiceContext) {
  const pairing = await Pairing.findById(id).lean();
  if (!pairing) throw new NotFoundError('Pairing not found');
  if (!pairing.open) throw new ConflictError('This pairing has already ended');
  const to = input.to ?? new Date();
  if (to < (pairing.from as Date)) throw new ValidationError('A pairing cannot end before it started', { to: [`Must be on or after ${(pairing.from as Date).toISOString()}`] });
  const result = await Pairing.updateOne({ _id: id, open: true }, { $set: { open: false, to, endReason: input.reason, status: 'archived', archivedAt: new Date(), updatedBy: ctx.actorId }, $inc: { version: 1 } });
  if (!result.modifiedCount) throw new ConflictError('This pairing has already ended');
  await syncCurrent([pairing.vehicleId], [pairing.trailerId]);
  await audit({ entity: 'pairings', entityId: id, action: 'update', summary: `Ended${input.reason ? `: ${input.reason}` : ''}`, actorId: ctx.actorId, requestId: ctx.requestId });
  return serialize(pairingDefinition, (await Pairing.findById(id).lean()) as Plain);
}

export const masters: MasterDefinition[] = [vehicleMakeDefinition, vehicleModelDefinition, vehicleTypeDefinition, vehicleDefinition, trailerTypeDefinition, trailerDefinition, pairingDefinition];
