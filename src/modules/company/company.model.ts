import { DEFAULT_AREAS } from './areaList.js';
import { Schema, model } from 'mongoose';
import { ObjectId, schemaOptions } from '../../core/masters/schema.js';
import { DECIMAL_SEPARATORS, THOUSANDS_SEPARATORS, TIME_FORMATS, UNIT_SYSTEMS, WEEK_STARTS } from '../../core/format/regional.js';

/**
 * How this company runs trips. The first client's way of working ships as the defaults; every value
 * can be changed per company (see the founding principle in the README).
 */
export const CARGO_KINDS = ['volume', 'weighed', 'counted'] as const;
export const LOADED_TRIP_OUTCOMES = ['return', 'transfer', 'write_off'] as const;
export const WRITE_OFF_CARRIERS = ['driver', 'company', 'insurance'] as const;
/** The company's Maintenance rules (#63). */
export const MAINTENANCE_DEFAULTS = {
  /** A new work order stops its truck until it is done; each order can say otherwise. */
  workOrderStopsTruck: true,
  /** A defect the driver reports stops the truck only if the company says so: the driver is usually on the road. */
  defectStopsTruck: false,
  /** How close a service is before it shows as due. */
  dueSoonKm: 1000,
  dueSoonDays: 14,
  dueSoonHours: 50,
};

export const OPERATIONS_DEFAULTS = {
  /** The kinds of cargo the company carries: its screens show only those measures (#75). */
  cargoKinds: [...CARGO_KINDS] as string[],
  /** What may happen to a load that can't be delivered (#64). */
  loadedTripOutcomes: [...LOADED_TRIP_OUTCOMES] as string[],
  /** Who may carry a write-off, and who does unless the person deciding says otherwise. */
  writeOffCarriers: [...WRITE_OFF_CARRIERS] as string[],
  writeOffDefaultCarrier: 'company',
  /** Role keys that may decide; owners and administrators always may. */
  loadedTripRoles: ['operations'] as string[],
  /** A write-off asked for by anyone else waits for the owner's approval. */
  writeOffNeedsOwner: true,
  /** A trip's first stop is where its truck is now. */
  tripStartsFromTruck: true,
  /** Road distance when no route gives the leg: straight-line distance × this factor. */
  roadDistanceFactor: 1.28,
  /** Used to estimate driving hours from distance. */
  averageSpeedKmh: 62,
  /** Delivered may exceed loaded by this much before it is refused as a misreading. */
  deliveredOverLoadedPercent: 2,
  /** Accepted fuel densities at loading and delivery, kg/m³. */
  densityMinKgM3: 600,
  densityMaxKgM3: 1000,
  /** Transit-loss allowance when neither a shortage policy nor the product sets one. */
  defaultShortageAllowancePercent: 0.3,
  /** Fuel reserve on the route estimate when no fuel norm sets one. */
  defaultFuelReservePercent: 6,
  /** How often drivers are settled; "any" lets Finance settle whenever. */
  settlementPeriod: 'any',
  /** A trip that left but never loaded (the customer cancelled, a breakdown) may be stopped and its truck freed. */
  stopBeforeLoading: true,
} as const;
export const SETTLEMENT_PERIODS = ['any', 'weekly', 'fortnightly', 'monthly'] as const;

/**
 * How this company carries freight: consignments, stops, revenue and profit (#135, consignments design 3.9).
 * Every default gives a company with one load and one drop exactly what it had before consignments.
 * Settings of later phases are stored now and say "Not built yet" on the screen until they act.
 */
export const CONSIGNMENT_BY = ['loading', 'dispatch'] as const;
export const CONSIGNOR_DEFAULTS = ['customer', 'empty'] as const;
export const DUPLICATE_CHECKS = ['warn', 'refuse', 'off'] as const;
export const LATE_SPLIT = ['by_type', 'always', 'never'] as const;
export const LEAVE_STOP_REQUIRES = ['lines', 'required_documents'] as const;
export const CAPACITY_CHECKS = ['refuse', 'warn', 'off'] as const;
export const RATE_REQUIRED = ['later', 'at_booking', 'at_loading'] as const;
export const FREIGHT_CHARGE_ON = ['loaded', 'delivered', 'planned', 'greater_of', 'lesser_of'] as const;
export const FREIGHT_PRICE_ON = ['pickup_date', 'delivery_date', 'booking_date', 'trip_dispatch'] as const;
export const FREIGHT_DISTANCE = ['route_lead', 'trip_loaded_km', 'manual'] as const;
export const FREIGHT_SHORTAGE = ['none', 'beyond_allowance', 'all'] as const;
export const SHORTAGE_SCOPES = ['consignment', 'drop'] as const;
export const DETENTION_SHARES = ['each', 'split'] as const;
export const COST_SHARES = ['weight', 'revenue', 'equal', 'km'] as const;
export const FREEZE_ON = ['invoice_or_settlement', 'delivery', 'manual'] as const;
export const PROFIT_COSTS = ['fuel', 'expenses', 'charges', 'losses', 'recovered', 'other', 'overhead'] as const;
export const TRANSFER_SPLITS = ['delivering_trip', 'first_trip', 'by_km'] as const;

export const FREIGHT_DEFAULTS = {
  consignmentBy: 'loading' as (typeof CONSIGNMENT_BY)[number],
  /** 0: no limit. 1 gives a single-load company a screen with no "Add consignment". */
  maxConsignmentsPerTrip: 0,
  defaultConsignmentTypeId: undefined as string | undefined,
  consignorDefault: 'customer' as (typeof CONSIGNOR_DEFAULTS)[number],
  consigneeMustBeParty: false,
  consigneePhoneRequired: false,
  createPlacesFromAddresses: true,
  duplicateCheck: 'warn' as (typeof DUPLICATE_CHECKS)[number],
  bookWithoutTrip: false,
  stopsEditableOnRoad: true,
  lateSplit: 'by_type' as (typeof LATE_SPLIT)[number],
  leaveStopRequires: ['lines', 'required_documents'] as string[],
  capacityCheck: 'refuse' as (typeof CAPACITY_CHECKS)[number],
  capacityTolerancePercent: 0,
  tripsWithoutCargo: false,
  podPerStopAllowed: false,
  notifyConsignee: false,
  ewayBillWarnHours: 0,
  consignmentRateRequired: 'later' as (typeof RATE_REQUIRED)[number],
  /** Empty: Money settings → "Bill on" (delivered by default), as before consignments. */
  chargeOnDefault: undefined as (typeof FREIGHT_CHARGE_ON)[number] | undefined,
  priceOnDefault: 'pickup_date' as (typeof FREIGHT_PRICE_ON)[number],
  distanceSourceDefault: 'route_lead' as (typeof FREIGHT_DISTANCE)[number],
  /** Empty: Money settings → "Shortage on the invoice" (deducted beyond the allowance by default), as before. */
  shortageDeductionDefault: undefined as (typeof FREIGHT_SHORTAGE)[number] | undefined,
  shortageScopeDefault: 'consignment' as (typeof SHORTAGE_SCOPES)[number],
  detentionShare: 'each' as (typeof DETENTION_SHARES)[number],
  costShareBy: 'weight' as (typeof COST_SHARES)[number],
  manualPriceNeedsReason: true,
  /** A rate typed outside the customer's rate contract waits for Finance (#151). Off: the person booking decides. */
  ownRateNeedsApproval: false,
  freezeOn: 'invoice_or_settlement' as (typeof FREEZE_ON)[number],
  invoiceWithoutPod: false,
  profitCosts: ['fuel', 'expenses', 'charges', 'losses', 'recovered', 'other'] as string[],
  /** Base-currency minor units per litre, when neither the fuel issue nor the fuel price list has a price. */
  defaultFuelPricePerLMinor: undefined as number | undefined,
  overheadPerKmMinor: 0,
  overheadPerDayMinor: 0,
  transferRevenueSplit: 'delivering_trip' as (typeof TRANSFER_SPLITS)[number],
  showProfitOnTripList: false,
};

const freightSchema = new Schema({
  consignmentBy: { type: String, enum: CONSIGNMENT_BY },
  maxConsignmentsPerTrip: { type: Number, min: 0, max: 1000 },
  defaultConsignmentTypeId: { type: ObjectId, ref: 'ConsignmentType' },
  consignorDefault: { type: String, enum: CONSIGNOR_DEFAULTS },
  consigneeMustBeParty: Boolean,
  consigneePhoneRequired: Boolean,
  createPlacesFromAddresses: Boolean,
  duplicateCheck: { type: String, enum: DUPLICATE_CHECKS },
  bookWithoutTrip: Boolean,
  stopsEditableOnRoad: Boolean,
  lateSplit: { type: String, enum: LATE_SPLIT },
  leaveStopRequires: { type: [{ type: String, enum: LEAVE_STOP_REQUIRES }], default: undefined },
  capacityCheck: { type: String, enum: CAPACITY_CHECKS },
  capacityTolerancePercent: { type: Number, min: 0, max: 50 },
  tripsWithoutCargo: Boolean,
  podPerStopAllowed: Boolean,
  notifyConsignee: Boolean,
  ewayBillWarnHours: { type: Number, min: 0, max: 720 },
  consignmentRateRequired: { type: String, enum: RATE_REQUIRED },
  chargeOnDefault: { type: String, enum: FREIGHT_CHARGE_ON },
  priceOnDefault: { type: String, enum: FREIGHT_PRICE_ON },
  distanceSourceDefault: { type: String, enum: FREIGHT_DISTANCE },
  shortageDeductionDefault: { type: String, enum: FREIGHT_SHORTAGE },
  shortageScopeDefault: { type: String, enum: SHORTAGE_SCOPES },
  detentionShare: { type: String, enum: DETENTION_SHARES },
  costShareBy: { type: String, enum: COST_SHARES },
  ownRateNeedsApproval: Boolean,
  manualPriceNeedsReason: Boolean,
  freezeOn: { type: String, enum: FREEZE_ON },
  invoiceWithoutPod: Boolean,
  profitCosts: { type: [{ type: String, enum: PROFIT_COSTS }], default: undefined },
  defaultFuelPricePerLMinor: { type: Number, min: 0, max: 1e9 },
  overheadPerKmMinor: { type: Number, min: 0, max: 1e9 },
  overheadPerDayMinor: { type: Number, min: 0, max: 1e11 },
  transferRevenueSplit: { type: String, enum: TRANSFER_SPLITS },
  showProfitOnTripList: Boolean,
}, { _id: false, strict: 'throw' });

const operationsSchema = new Schema({
  cargoKinds: { type: [{ type: String, enum: CARGO_KINDS }], default: () => [...OPERATIONS_DEFAULTS.cargoKinds] },
  loadedTripOutcomes: { type: [{ type: String, enum: LOADED_TRIP_OUTCOMES }], default: () => [...OPERATIONS_DEFAULTS.loadedTripOutcomes] },
  writeOffCarriers: { type: [{ type: String, enum: WRITE_OFF_CARRIERS }], default: () => [...OPERATIONS_DEFAULTS.writeOffCarriers] },
  writeOffDefaultCarrier: { type: String, enum: WRITE_OFF_CARRIERS, default: OPERATIONS_DEFAULTS.writeOffDefaultCarrier },
  loadedTripRoles: { type: [String], default: () => [...OPERATIONS_DEFAULTS.loadedTripRoles] },
  writeOffNeedsOwner: { type: Boolean, default: OPERATIONS_DEFAULTS.writeOffNeedsOwner },
  tripStartsFromTruck: { type: Boolean, default: OPERATIONS_DEFAULTS.tripStartsFromTruck },
  roadDistanceFactor: { type: Number, min: 1, max: 3, default: OPERATIONS_DEFAULTS.roadDistanceFactor },
  averageSpeedKmh: { type: Number, min: 10, max: 120, default: OPERATIONS_DEFAULTS.averageSpeedKmh },
  deliveredOverLoadedPercent: { type: Number, min: 0, max: 20, default: OPERATIONS_DEFAULTS.deliveredOverLoadedPercent },
  densityMinKgM3: { type: Number, min: 0, max: 2000, default: OPERATIONS_DEFAULTS.densityMinKgM3 },
  densityMaxKgM3: { type: Number, min: 0, max: 2000, default: OPERATIONS_DEFAULTS.densityMaxKgM3 },
  defaultShortageAllowancePercent: { type: Number, min: 0, max: 10, default: OPERATIONS_DEFAULTS.defaultShortageAllowancePercent },
  defaultFuelReservePercent: { type: Number, min: 0, max: 50, default: OPERATIONS_DEFAULTS.defaultFuelReservePercent },
  settlementPeriod: { type: String, enum: SETTLEMENT_PERIODS, default: OPERATIONS_DEFAULTS.settlementPeriod },
  stopBeforeLoading: { type: Boolean, default: OPERATIONS_DEFAULTS.stopBeforeLoading },
}, { _id: false, strict: 'throw' });

const maintenanceSchema = new Schema({
  workOrderStopsTruck: { type: Boolean, default: MAINTENANCE_DEFAULTS.workOrderStopsTruck },
  defectStopsTruck: { type: Boolean, default: MAINTENANCE_DEFAULTS.defectStopsTruck },
  dueSoonKm: { type: Number, min: 0, max: 100_000, default: MAINTENANCE_DEFAULTS.dueSoonKm },
  dueSoonDays: { type: Number, min: 0, max: 365, default: MAINTENANCE_DEFAULTS.dueSoonDays },
  dueSoonHours: { type: Number, min: 0, max: 10_000, default: MAINTENANCE_DEFAULTS.dueSoonHours },
}, { _id: false, strict: 'throw' });

/**
 * Where daily exchange rates come from (Exchange rates → Rate feed). "manual" means none: people type
 * rates in. The provider's API key is the RATE_FEED_API_KEY secret, never stored here.
 */
const rateFeedSchema = new Schema({
  provider: { type: String, default: 'manual' },
  /** Currencies to fetch against the base; empty means every active currency. */
  currencyIds: { type: [{ type: Schema.Types.ObjectId, ref: 'Currency' }], default: [] },
  /** When the daily fetch should run, company time (the scheduler that calls rates:fetch follows it). */
  fetchAt: { type: String, default: '06:00' },
}, { _id: false, strict: 'throw' });

/** How dates, times and numbers are written (#72). Unset values follow the country, then neutral defaults (core/format/regional.ts). */
const regionalSchema = new Schema({
  timeFormat: { type: String, enum: TIME_FORMATS },
  decimalSeparator: { type: String, enum: DECIMAL_SEPARATORS },
  thousandsSeparator: { type: String, enum: THOUSANDS_SEPARATORS },
  firstDayOfWeek: { type: String, enum: WEEK_STARTS },
  phoneCountryCode: String,
  unitSystem: { type: String, enum: UNIT_SYSTEMS },
}, { _id: false, strict: 'throw' });

/** The transporter using this deployment. Exactly one document. */
const companySchema = new Schema<any>({
  /** Fixed value with a unique index, so only one company document can exist. */
  singleton: { type: String, default: 'company', enum: ['company'] },
  legalName: { type: String, required: true, trim: true },
  tradingName: String,
  registrationNumber: String,
  taxId: String,
  countryId: { type: ObjectId, ref: 'Country' },
  baseCurrencyId: { type: ObjectId, ref: 'Currency' },
  /** Unset: the country's first time zone (Company → Regional settings). */
  timezone: String,
  fiscalYearStartMonth: { type: Number, min: 1, max: 12, default: 1 },
  dateFormat: { type: String, enum: ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'], default: 'DD/MM/YYYY' },
  allowSelfRegistration: { type: Boolean, default: false },
  modules: { type: [String], default: () => [...DEFAULT_AREAS] },
  operations: { type: operationsSchema, default: () => ({}) },
  maintenance: { type: maintenanceSchema, default: () => ({}) },
  freight: { type: freightSchema, default: () => ({}) },
  rateFeed: { type: rateFeedSchema, default: () => ({}) },
  regional: { type: regionalSchema, default: () => ({}) },
  address: { line1: String, line2: String, city: String, postalCode: String },
  phone: String,
  email: String,
  website: String,
  logoUrl: String,
  /** How the product looks to everyone who uses it (#71): the company's name, logo, colour and message signature. */
  brand: {
    type: new Schema({
      productName: String,
      shortName: String,
      /** Stored files (the files module): the logo for screens, a version for dark backgrounds, a square icon, and a JPEG for PDFs. */
      logoFileId: { type: ObjectId, ref: 'StoredFile' },
      logoDarkFileId: { type: ObjectId, ref: 'StoredFile' },
      iconFileId: { type: ObjectId, ref: 'StoredFile' },
      logoPdfFileId: { type: ObjectId, ref: 'StoredFile' },
      accent: String,
      emailSenderName: String,
      signature: String,
    }, { _id: false }),
    default: () => ({}),
  },
  /** A mark across printed documents and previews (#71). */
  watermark: {
    type: new Schema({
      mode: { type: String, enum: ['off', 'text', 'logo'], default: 'off' },
      text: String,
      opacity: { type: Number, min: 0.03, max: 0.5, default: 0.08 },
      angle: { type: Number, min: -90, max: 90, default: 35 },
      tripSheet: { type: Boolean, default: true },
      statement: { type: Boolean, default: true },
      invoice: { type: Boolean, default: true },
      screens: { type: Boolean, default: false },
    }, { _id: false }),
    default: () => ({}),
  },
  /** The company's own words, stages and desks (#73): only its changes over the defaults in workspace.ts. */
  vocabulary: { type: Schema.Types.Mixed, default: undefined },
  stages: { type: Schema.Types.Mixed, default: undefined },
  desks: { type: [Schema.Types.Mixed], default: undefined },
  updatedBy: { type: ObjectId, ref: 'User' },
}, { ...schemaOptions, minimize: true });
companySchema.index({ singleton: 1 }, { unique: true });

export const Company = model('Company', companySchema);
