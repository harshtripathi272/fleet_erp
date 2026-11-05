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
  /** Which position moves a truck when a tracker and the driver's phone both report (#60): "newest", "tracker" or "phone". */
  positionSource: 'newest',
  /** Arrival and departure at stops from tracker positions: "auto" is on only while a real GPS connection is in use. */
  arrivalDetection: 'auto',
  /** How long a truck stays inside a stop's geofence before it counts as arrived. */
  arrivalDwellMinutes: 3,
  /** How often trackers that are asked (not pushing) are asked for positions. */
  trackerPollSeconds: 60,
} as const;
export const SETTLEMENT_PERIODS = ['any', 'weekly', 'fortnightly', 'monthly'] as const;
export const POSITION_SOURCES = ['newest', 'tracker', 'phone'] as const;
export const ARRIVAL_DETECTION = ['auto', 'on', 'off'] as const;

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
  positionSource: { type: String, enum: POSITION_SOURCES, default: OPERATIONS_DEFAULTS.positionSource },
  arrivalDetection: { type: String, enum: ARRIVAL_DETECTION, default: OPERATIONS_DEFAULTS.arrivalDetection },
  arrivalDwellMinutes: { type: Number, min: 0, max: 120, default: OPERATIONS_DEFAULTS.arrivalDwellMinutes },
  trackerPollSeconds: { type: Number, min: 15, max: 3600, default: OPERATIONS_DEFAULTS.trackerPollSeconds },
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
  updatedBy: { type: ObjectId, ref: 'User' },
}, { ...schemaOptions, minimize: true });
companySchema.index({ singleton: 1 }, { unique: true });

export const Company = model('Company', companySchema);
