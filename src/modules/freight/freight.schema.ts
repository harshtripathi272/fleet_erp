import { z } from 'zod';
import { baseShape, code, money, name, objectId, percent, text, toUpdateSchema } from '../../core/masters/zod.js';
import {
  CARGO_KINDS, CHARGE_DIRECTIONS, CHARGE_KINDS, CHARGE_ON, DISTANCE_SOURCES, DOCUMENT_REQUIRED_BY, DOCUMENT_STEPS, DRIVER_KINDS,
  PRICE_ON, RATE_BASES, READ_FIELDS, SHORTAGE_DEDUCTIONS, SLAB_MODES,
} from './models/freight.model.js';

/** Request bodies for the freight masters (#135, consignments design 3.4). */

export const consignmentTypeShape = {
  code, name, description: text(500).optional(),
  cargoKind: z.enum(CARGO_KINDS).optional(),
  multiDrop: z.boolean().optional(),
  multiPickup: z.boolean().optional(),
  splitDecidedLate: z.boolean().optional(),
  defaultTariffBasis: z.enum(RATE_BASES).optional(),
  requiredDocuments: z.array(z.strictObject({ documentTypeId: objectId, step: z.enum(DOCUMENT_STEPS) })).max(20).optional(),
  podTypeId: objectId.optional(),
  requireConsigneeParty: z.boolean().optional(),
  ...baseShape,
};

export const consignmentDocumentTypeShape = {
  code, name, description: text(500).optional(),
  step: z.enum(DOCUMENT_STEPS),
  requiredBy: z.enum(DOCUMENT_REQUIRED_BY).optional(),
  perLeg: z.boolean().optional(),
  hasNumber: z.boolean().optional(),
  hasDate: z.boolean().optional(),
  hasAmount: z.boolean().optional(),
  hasValidity: z.boolean().optional(),
  driverKind: z.enum(DRIVER_KINDS).optional(),
  readFields: z.array(z.enum(READ_FIELDS)).max(READ_FIELDS.length).refine((v) => new Set(v).size === v.length, 'Each once').optional(),
  ...baseShape,
};

export const chargeTypeShape = {
  code, name, description: text(500).optional(),
  kind: z.enum(CHARGE_KINDS),
  direction: z.enum(CHARGE_DIRECTIONS).optional(),
  defaultBasis: z.enum(RATE_BASES).optional(),
  defaultPrice: money.optional(),
  defaultPercent: z.number().min(-100).max(1000).optional(),
  autoApply: z.boolean().optional(),
  taxable: z.boolean().optional(),
  printLabel: text(120).optional(),
  ...baseShape,
};

const tariffLine = z.strictObject({
  /** Kept on an edit so revenue lines that name it still find it. */
  _id: objectId.optional(),
  chargeTypeId: objectId,
  description: text(200).optional(),
  basis: z.enum(RATE_BASES),
  price: money.optional(),
  slabs: z.array(z.strictObject({ upTo: z.number().min(0).max(1e9).nullable().optional(), price: money })).max(20).optional(),
  slabMode: z.enum(SLAB_MODES).optional(),
  percent: z.number().min(-100).max(1000).optional(),
  when: text(500).optional(),
  formula: text(500).optional(),
  perLine: z.boolean().optional(),
  freeQty: z.number().min(0).max(1000).optional(),
  minimum: money.optional(),
  maximum: money.optional(),
  taxRatePercent: percent.optional(),
  order: z.number().int().min(0).max(10_000).optional(),
});

export const tariffShape = {
  code, name, description: text(500).optional(),
  customerId: objectId.optional(),
  consignorPartyId: objectId.optional(),
  consignmentTypeId: objectId.optional(),
  routeId: objectId.optional(),
  fromPlaceId: objectId.optional(),
  toPlaceId: objectId.optional(),
  fromCountryId: objectId.optional(),
  toCountryId: objectId.optional(),
  productId: objectId.optional(),
  productGroupId: objectId.optional(),
  vehicleTypeId: objectId.optional(),
  currencyId: objectId,
  priceOn: z.enum(PRICE_ON).optional(),
  chargeOn: z.enum(CHARGE_ON).optional(),
  distanceSource: z.enum(DISTANCE_SOURCES).optional(),
  shortageDeduction: z.enum(SHORTAGE_DEDUCTIONS).optional(),
  shortageAllowancePercent: percent.optional(),
  taxRatePercent: percent.optional(),
  volumetricDivisorKgPerM3: z.number().min(1).max(10_000).optional(),
  minimumChargeableKg: z.number().min(0).max(1e6).optional(),
  roundQtyUpTo: z.number().min(0).max(10_000).optional(),
  lines: z.array(tariffLine).min(1, 'Add at least one charge line').max(50),
  minimumCharge: money.optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
  ...baseShape,
};

export const fuelPriceShape = {
  code, name, description: text(500).optional(),
  fuelTypeId: objectId.optional(),
  placeId: objectId.optional(),
  countryId: objectId.optional(),
  pricePerL: money.refine((m) => m.amountMinor > 0, 'Enter the price of a litre'),
  ...baseShape,
};

export const createConsignmentTypeSchema = z.strictObject(consignmentTypeShape);
export const updateConsignmentTypeSchema = toUpdateSchema(consignmentTypeShape);
export const createConsignmentDocumentTypeSchema = z.strictObject(consignmentDocumentTypeShape);
export const updateConsignmentDocumentTypeSchema = toUpdateSchema(consignmentDocumentTypeShape);
export const createChargeTypeSchema = z.strictObject(chargeTypeShape);
export const updateChargeTypeSchema = toUpdateSchema(chargeTypeShape);
export const createTariffSchema = z.strictObject(tariffShape);
export const updateTariffSchema = toUpdateSchema(tariffShape);
export const createFuelPriceSchema = z.strictObject(fuelPriceShape);
export const updateFuelPriceSchema = toUpdateSchema(fuelPriceShape);
