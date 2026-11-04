import { DEFAULT_AREAS } from './areaList.js';
import { Schema, model } from 'mongoose';
import { ObjectId, schemaOptions } from '../../core/masters/schema.js';

/**
 * How this company runs trips. The first client's way of working ships as the defaults; every value
 * can be changed per company (see the founding principle in the README).
 */
export const OPERATIONS_DEFAULTS = {
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

const operationsSchema = new Schema({
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
  timezone: { type: String, default: 'Africa/Lusaka' },
  fiscalYearStartMonth: { type: Number, min: 1, max: 12, default: 1 },
  dateFormat: { type: String, enum: ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'], default: 'DD/MM/YYYY' },
  allowSelfRegistration: { type: Boolean, default: false },
  modules: { type: [String], default: () => [...DEFAULT_AREAS] },
  operations: { type: operationsSchema, default: () => ({}) },
  rateFeed: { type: rateFeedSchema, default: () => ({}) },
  address: { line1: String, line2: String, city: String, postalCode: String },
  phone: String,
  email: String,
  website: String,
  logoUrl: String,
  updatedBy: { type: ObjectId, ref: 'User' },
}, { ...schemaOptions, minimize: true });
companySchema.index({ singleton: 1 }, { unique: true });

export const Company = model('Company', companySchema);
