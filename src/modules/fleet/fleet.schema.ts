import { z } from 'zod';
import { baseShape, code, idList, integer, isoDate, money, name, objectId, text, toUpdateSchema } from '../../core/masters/zod.js';
import { AXLE_CONFIGURATIONS } from './models/vehicleModel.model.js';
import { CARGO_KINDS } from './models/trailerType.model.js';
import { OPERATIONAL_STATUSES, OWNERSHIP } from './models/vehicle.model.js';
import { VEHICLE_CATEGORIES } from './models/vehicleType.model.js';

const thisYear = new Date().getUTCFullYear();
const plate = z.string().trim().toUpperCase().transform((v) => v.replace(/\s+/g, ' '))
  .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9 -]{1,14}$/, 'Registration plate: 2-15 letters, digits, spaces or dashes'));
const serial = (label: string) => z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{5,30}$/, `${label}: 5-30 letters, digits or dashes`);
const kmPerL = z.number().positive().max(15);
const kg = z.number().positive().max(200000);
const datedAmount = z.strictObject({ date: isoDate, amount: money.optional() });

export const vehicleMakeShape = { code, name, description: text(500).optional(), countryId: objectId.optional(), ...baseShape };

export const vehicleModelShape = {
  code, name, description: text(500).optional(),
  makeId: objectId,
  vehicleTypeId: objectId.optional(),
  axleConfiguration: z.enum(AXLE_CONFIGURATIONS).optional(),
  engine: text(80).optional(),
  grossVehicleMassKg: kg.optional(),
  grossCombinationMassKg: kg.optional(),
  tankCapacityL: z.number().positive().max(5000).optional(),
  kmPerLLoaded: kmPerL.optional(),
  kmPerLEmpty: kmPerL.optional(),
  ...baseShape,
};

export const vehicleTypeShape = {
  code, name, description: text(500).optional(),
  category: z.enum(VEHICLE_CATEGORIES),
  towsTrailer: z.boolean().optional(),
  licenceClassIds: idList(20).optional(),
  requiredDocumentTypeIds: idList(30).optional(),
  ...baseShape,
};

export const vehicleShape = {
  code,
  registrationNumber: plate,
  vin: serial('Chassis/VIN').optional(),
  engineNumber: serial('Engine number').optional(),
  makeId: objectId,
  modelId: objectId.optional(),
  vehicleTypeId: objectId,
  year: integer(1950, thisYear + 1).optional(),
  colour: text(40).optional(),
  ownership: z.enum(OWNERSHIP).optional(),
  ownerPartyId: objectId.optional(),
  financierPartyId: objectId.optional(),
  dealerPartyId: objectId.optional(),
  homeBranchId: objectId.optional(),
  odometerKm: z.number().min(0).max(5_000_000).optional(),
  engineHours: z.number().min(0).max(5_000_000).optional(),
  tankCapacityL: z.number().positive().max(5000).optional(),
  fuelTypeId: objectId.optional(),
  kmPerLLoaded: kmPerL.optional(),
  kmPerLEmpty: kmPerL.optional(),
  tareKg: kg.optional(),
  payloadKg: kg.optional(),
  gpsDeviceId: text(60).optional(),
  gpsVendor: text(60).optional(),
  fuelCardNumber: z.string().trim().regex(/^[A-Za-z0-9 -]{4,30}$/, '4-30 letters, digits, spaces or dashes').optional(),
  operationalStatus: z.enum(OPERATIONAL_STATUSES).optional(),
  registrationDate: isoDate.optional(),
  purchase: datedAmount.optional(),
  sale: datedAmount.optional(),
  regulatorRefs: z.array(z.strictObject({ authority: text(40), number: text(60) })).max(10).optional(),
  ...baseShape,
};

export const trailerTypeShape = {
  code, name, description: text(500).optional(),
  cargoKinds: z.array(z.enum(CARGO_KINDS)).min(1).max(CARGO_KINDS.length).refine((v) => new Set(v).size === v.length, 'Values must be unique'),
  hasCompartments: z.boolean().optional(),
  requiredDocumentTypeIds: idList(30).optional(),
  ...baseShape,
};

export const trailerShape = {
  code,
  registrationNumber: plate,
  chassisNumber: serial('Chassis number').optional(),
  trailerTypeId: objectId,
  make: text(60).optional(),
  model: text(60).optional(),
  year: integer(1950, thisYear + 1).optional(),
  axles: integer(1, 8).optional(),
  tareKg: kg.optional(),
  capacityKg: kg.optional(),
  capacityL: z.number().positive().max(100000).optional(),
  compartments: z.array(z.strictObject({ number: integer(1, 12), capacityL: z.number().positive().max(50000) })).max(12).optional(),
  ownership: z.enum(OWNERSHIP).optional(),
  ownerPartyId: objectId.optional(),
  homeBranchId: objectId.optional(),
  operationalStatus: z.enum(OPERATIONAL_STATUSES).optional(),
  ...baseShape,
};

export const createVehicleMakeSchema = z.strictObject(vehicleMakeShape);
export const updateVehicleMakeSchema = toUpdateSchema(vehicleMakeShape);
export const createVehicleModelSchema = z.strictObject(vehicleModelShape);
export const updateVehicleModelSchema = toUpdateSchema(vehicleModelShape);
export const createVehicleTypeSchema = z.strictObject(vehicleTypeShape);
export const updateVehicleTypeSchema = toUpdateSchema(vehicleTypeShape);
export const createVehicleSchema = z.strictObject(vehicleShape);
export const updateVehicleSchema = toUpdateSchema(vehicleShape);
export const createTrailerTypeSchema = z.strictObject(trailerTypeShape);
export const updateTrailerTypeSchema = toUpdateSchema(trailerTypeShape);
export const createTrailerSchema = z.strictObject(trailerShape);
export const updateTrailerSchema = toUpdateSchema(trailerShape);

export const pairSchema = z.strictObject({
  vehicleId: objectId,
  trailerId: objectId,
  from: isoDate.optional(),
  reason: text(300).optional(),
});
export const endPairingSchema = z.strictObject({ to: isoDate.optional(), reason: text(300).optional() }).default({});
/** Pairings are never edited, only ended (POST /pairings/:id/end). */
export const pairingPlaceholderSchema = z.strictObject({});
