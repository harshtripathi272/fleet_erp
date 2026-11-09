import { Schema } from 'mongoose';
import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, masterModel, masterSchema, moneySchema } from '../../../core/masters/schema.js';

/**
 * The freight masters (consignments design 3.4): what kinds of consignment a company carries, the papers that go
 * with them, the kinds of money line on a bill, the tariffs that price a consignment, and fuel prices for trip
 * profit. Every one is an ordinary master: the company can rename, add, switch off and import them.
 */

/* ---------- Consignment types ---------- */

export const CARGO_KINDS = ['volume', 'weighed', 'counted'] as const;

/** What kind of consignment this is and which rules apply to it by default. */
const consignmentTypeSchema = masterSchema({
  ...codeNameFields,
  /** The measure new goods lines of this type default to. */
  cargoKind: { type: String, enum: CARGO_KINDS },
  /** May be dropped at several places. */
  multiDrop: { type: Boolean, default: false },
  /** May be picked up at several places (two terminals, two invoices). */
  multiPickup: { type: Boolean, default: false },
  /** Its drops may be left "to be confirmed" when it is booked, and split later. */
  splitDecidedLate: { type: Boolean, default: false },
  /** A hint for the tariff editor. */
  defaultTariffBasis: String,
  /** Papers this type needs at each step, on top of the ones every consignment needs. */
  requiredDocuments: { type: [new Schema({ documentTypeId: { type: ObjectId, ref: 'ConsignmentDocumentType', required: true }, step: { type: String, enum: ['booking', 'pickup', 'transit', 'drop', 'close'], required: true } }, { _id: false, strict: 'throw' })], default: undefined },
  podTypeId: { type: ObjectId, ref: 'PodType' },
  /** The consignee must be a party record, not just a name and phone. */
  requireConsigneeParty: { type: Boolean, default: false },
});
uniqueIndex(consignmentTypeSchema, { code: 1 });
export const ConsignmentType = masterModel('ConsignmentType', consignmentTypeSchema);

/* ---------- Consignment document types ---------- */

export const DOCUMENT_STEPS = ['booking', 'pickup', 'transit', 'drop', 'close'] as const;
export const DOCUMENT_REQUIRED_BY = ['none', 'to_leave_stop', 'to_close_trip', 'to_invoice'] as const;
/** What a driver's photo of this paper is filed as (DriverDocument.kind). */
export const DRIVER_KINDS = ['loading', 'delivery', 'pod', 'weighbridge', 'permit', 'eway', 'other'] as const;

const consignmentDocumentTypeSchema = masterSchema({
  ...codeNameFields,
  step: { type: String, enum: DOCUMENT_STEPS, required: true },
  requiredBy: { type: String, enum: DOCUMENT_REQUIRED_BY, default: 'none' },
  /** One per pickup or drop, rather than one per consignment. */
  perLeg: { type: Boolean, default: false },
  hasNumber: { type: Boolean, default: true },
  hasDate: { type: Boolean, default: false },
  hasAmount: { type: Boolean, default: false },
  hasValidity: { type: Boolean, default: false },
  driverKind: { type: String, enum: DRIVER_KINDS, default: 'other' },
});
uniqueIndex(consignmentDocumentTypeSchema, { code: 1 });
export const ConsignmentDocumentType = masterModel('ConsignmentDocumentType', consignmentDocumentTypeSchema);

/* ---------- Charge types ---------- */

export const CHARGE_KINDS = ['freight', 'minimum', 'charge', 'deduction'] as const;
export const CHARGE_DIRECTIONS = ['revenue', 'cost'] as const;

/**
 * How a tariff line is worked out (design 3.5.2). Phase 1 builds these; the rest of the list (waiting hours,
 * percentages, pass-through costs, formulas) comes with the full rate engine.
 */
export const RATE_BASES = [
  'per_consignment', 'per_trip', 'per_tonne', 'per_kg', 'per_litre', 'per_litre_20', 'per_m3', 'per_piece', 'per_km', 'per_tonne_km',
  'per_drop_beyond', 'shortage_beyond_allowance',
] as const;
export type RateBasis = (typeof RATE_BASES)[number];

const chargeTypeSchema = masterSchema({
  ...codeNameFields,
  kind: { type: String, enum: CHARGE_KINDS, required: true },
  /** Billed to the customer, or a cost the company pays (a broker's commission). */
  direction: { type: String, enum: CHARGE_DIRECTIONS, default: 'revenue' },
  defaultBasis: { type: String, enum: RATE_BASES },
  defaultPrice: { type: moneySchema, default: undefined },
  taxable: { type: Boolean, default: true },
  accountCodeId: { type: ObjectId, ref: 'AccountCode' },
  /** The words on the invoice; the name when empty. */
  printLabel: String,
});
uniqueIndex(chargeTypeSchema, { code: 1 });
export const ChargeType = masterModel('ChargeType', chargeTypeSchema);

/* ---------- Tariffs ---------- */

export const PRICE_ON = ['pickup_date', 'delivery_date', 'booking_date', 'trip_dispatch'] as const;
export const CHARGE_ON = ['loaded', 'delivered', 'planned', 'greater_of', 'lesser_of'] as const;
export const DISTANCE_SOURCES = ['route_lead', 'trip_loaded_km', 'manual'] as const;
export const SHORTAGE_DEDUCTIONS = ['none', 'beyond_allowance', 'all'] as const;

const tariffLineSchema = new Schema({
  chargeTypeId: { type: ObjectId, ref: 'ChargeType', required: true },
  description: String,
  basis: { type: String, enum: RATE_BASES, required: true },
  /** Per unit of the basis, or the flat amount. In the tariff's currency. */
  price: { type: moneySchema, default: undefined },
  /** Free drops before an extra-drop charge starts. */
  freeQty: Number,
  minimum: { type: moneySchema, default: undefined },
  maximum: { type: moneySchema, default: undefined },
  taxRatePercent: { type: Number, min: 0, max: 100 },
  order: { type: Number, default: 100 },
}, { _id: true, strict: 'throw' });

/** A rate agreement: who it is for, when it applies, and its charge lines. Its dates are the master's own validFrom and validTo. */
const tariffSchema = masterSchema({
  ...codeNameFields,
  customerId: { type: ObjectId, ref: 'Party' },
  consignorPartyId: { type: ObjectId, ref: 'Party' },
  consignmentTypeId: { type: ObjectId, ref: 'ConsignmentType' },
  routeId: { type: ObjectId, ref: 'Route' },
  fromPlaceId: { type: ObjectId, ref: 'Place' },
  toPlaceId: { type: ObjectId, ref: 'Place' },
  fromCountryId: { type: ObjectId, ref: 'Country' },
  toCountryId: { type: ObjectId, ref: 'Country' },
  productId: { type: ObjectId, ref: 'Product' },
  productGroupId: { type: ObjectId, ref: 'ProductGroup' },
  vehicleTypeId: { type: ObjectId, ref: 'VehicleType' },
  currencyId: { type: ObjectId, ref: 'Currency', required: true },
  /** Empty: the company's default (Company → Freight). */
  priceOn: { type: String, enum: PRICE_ON },
  chargeOn: { type: String, enum: CHARGE_ON },
  distanceSource: { type: String, enum: DISTANCE_SOURCES },
  shortageDeduction: { type: String, enum: SHORTAGE_DEDUCTIONS },
  shortageAllowancePercent: { type: Number, min: 0, max: 100 },
  taxRatePercent: { type: Number, min: 0, max: 100 },
  lines: { type: [tariffLineSchema], required: true },
  /** The least the consignment's freight comes to, in the tariff's currency. */
  minimumCharge: { type: moneySchema, default: undefined },
  /** Breaks a tie between two equally specific tariffs: higher wins. */
  priority: { type: Number, default: 0 },
});
uniqueIndex(tariffSchema, { code: 1 });
tariffSchema.index({ customerId: 1, status: 1, validFrom: -1 });
export const Tariff = masterModel('Tariff', tariffSchema);

/* ---------- Fuel prices ---------- */

/** What a litre of fuel costs, for trip profit, when the fuel issue doesn't say. */
const fuelPriceSchema = masterSchema({
  ...codeNameFields,
  fuelTypeId: { type: ObjectId, ref: 'FuelType' },
  placeId: { type: ObjectId, ref: 'Place' },
  countryId: { type: ObjectId, ref: 'Country' },
  pricePerL: { type: moneySchema, required: true },
});
uniqueIndex(fuelPriceSchema, { code: 1 });
export const FuelPrice = masterModel('FuelPrice', fuelPriceSchema);
