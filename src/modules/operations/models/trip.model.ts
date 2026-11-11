import { Schema } from 'mongoose';
import { opsModel } from './model.js';
import { ObjectId, moneySchema, schemaOptions } from '../../../core/masters/schema.js';

/** Where an arrival or a position came from. */
export const ARRIVAL_SOURCES = ['office', 'driver', 'simulator', 'gps'] as const;
export type ArrivalSource = (typeof ARRIVAL_SOURCES)[number];

export const STOP_KINDS = ['start', 'load', 'via', 'border', 'offload', 'end'] as const;

const stopSchema = new Schema({
  placeId: { type: ObjectId, ref: 'Place', required: true },
  kind: { type: String, enum: STOP_KINDS, required: true },
  legKm: { type: Number, min: 0, required: true },
  legHours: { type: Number, min: 0, required: true },
  arrivedAt: Date,
  /** Who reported the arrival. `simulator` marks a demo drive, never a real one. */
  arrivedVia: { type: String, enum: ARRIVAL_SOURCES },
  leftAt: Date,
  /** The stop type it is, from the stop activity types (phase 2 of the consignments design); `kind` drives the arithmetic. */
  activityTypeId: { type: ObjectId, ref: 'StopType' },
  /** Where it came from: the route, a consignment's pickup or drop, or the office adding it. */
  origin: { type: String, enum: ['route', 'consignment', 'office'] },
  /** Added after dispatch (a late split, a backhaul), and by whom. */
  addedAt: Date,
  addedBy: { type: ObjectId, ref: 'User' },
  /** Nothing is planned here any more; kept for the sheet, skipped by the gates. */
  skipped: Boolean,
  /** Someone allowed to let the truck pass this stop before its consignments were recorded, and why. */
  gatePassed: { type: new Schema({ at: Date, by: { type: ObjectId, ref: 'User' }, byName: String, reason: String }, { _id: false }), default: undefined },
}, { strict: 'throw' });

/** A cost the system doesn't track yet, typed on the trip for its profit (a toll account, the driver's trip pay). */
const costLineSchema = new Schema({
  chargeTypeId: { type: ObjectId, ref: 'ChargeType' },
  label: { type: String, required: true },
  amount: { type: moneySchema, required: true },
  baseAmountMinor: { type: Number, required: true },
  note: String,
  at: { type: Date, required: true },
  by: { type: ObjectId, ref: 'User' },
  byName: String,
}, { _id: true, strict: 'throw' });

/** The last worked-out profit, so lists and reports can sort and total without working it out again. */
const profitSnapshotSchema = new Schema({
  status: { type: String, enum: ['estimate', 'provisional', 'final'], required: true },
  revenueMinor: Number,
  costMinor: Number,
  profitMinor: Number,
  complete: Boolean,
  at: Date,
}, { _id: false, strict: 'throw' });

const stageStepSchema = new Schema({
  stageId: { type: ObjectId, ref: 'TripStage', required: true },
  code: { type: String, required: true },
  name: { type: String, required: true },
  completesOn: { type: String, required: true },
  actorRoleKey: String,
  isFinal: Boolean,
  completedAt: Date,
  completedBy: { type: ObjectId, ref: 'User' },
}, { _id: false, strict: 'throw' });

/**
 * One run of one truck: the plan (customer, truck, trailer, driver, stops, budgets) and what happened
 * (dispatch, stop times, end). `active` is true until the trip ends or is cancelled, and unique
 * partial indexes on it keep a truck, trailer or driver on one trip at a time.
 */
const tripSchema = new Schema<any>({
  number: { type: String, required: true },
  nominationId: { type: ObjectId, ref: 'Nomination' },
  /** The trip type and its stages as they were when the trip was created; the trip moves through them. */
  tripTypeId: { type: ObjectId, ref: 'TripType' },
  stages: { type: [stageStepSchema], default: [] },
  events: { type: [String], default: [] },
  customerId: { type: ObjectId, ref: 'Party', required: true },
  vehicleId: { type: ObjectId, ref: 'Vehicle', required: true },
  trailerId: { type: ObjectId, ref: 'Trailer' },
  driverId: { type: ObjectId, ref: 'Driver' },
  routeId: { type: ObjectId, ref: 'Route' },
  productId: { type: ObjectId, ref: 'Product' },
  plannedQty: { type: Number, min: 0 },
  plannedStart: { type: Date, required: true },
  stops: { type: [stopSchema], default: [] },
  fuelBudgetL: { type: Number, min: 0, default: 0 },
  cashBudget: { type: moneySchema, required: true },
  openingFuelL: { type: Number, min: 0, default: 0 },
  dispatchedAt: Date,
  endedAt: Date,
  closingFuelL: { type: Number, min: 0 },
  cancelledAt: Date,
  cancelReason: String,
  /** Stopped after leaving, before anything was loaded; the trip is closed like an ended one. */
  stopReason: String,
  /** Company fields, asked at each field's step (#67). */
  custom: { type: Schema.Types.Mixed, default: undefined },
  /** What was decided for a load this trip couldn't deliver (#64). */
  undelivered: {
    type: new Schema({ outcome: { type: String, enum: ['return', 'transfer', 'write_off'], required: true }, reasonId: { type: ObjectId, ref: 'CancellationReason' }, reason: String, at: Date, by: { type: ObjectId, ref: 'User' } }, { _id: false }),
    default: undefined,
  },
  transferredToTripId: { type: ObjectId, ref: 'Trip' },
  transferredFromTripId: { type: ObjectId, ref: 'Trip' },
  /** Cancelled after cash was paid or spent on it: the trip still goes on the driver's next settlement. */
  settleAfterCancel: Boolean,
  /** The latest position. `source` says where it came from; `simulator` positions are a demo, not the truck. */
  tracking: { type: new Schema({ km: Number, speed: Number, heading: Number, at: Date, source: { type: String, enum: ARRIVAL_SOURCES } }, { _id: false }), default: undefined },
  settlementId: { type: ObjectId, ref: 'Settlement' },
  costLines: { type: [costLineSchema], default: undefined },
  profit: { type: profitSnapshotSchema, default: undefined },
  active: { type: Boolean, default: true },
  /**
   * Planned behind the truck's trip on the road (#102: the next job lined up while it comes back). Not active until
   * that trip ends or is cancelled, so the one-trip-at-a-time rule holds; it starts where that trip ends.
   */
  startsAfterTripId: { type: ObjectId, ref: 'Trip' },
  createdBy: { type: ObjectId, ref: 'User' },
  updatedBy: { type: ObjectId, ref: 'User' },
}, schemaOptions);

tripSchema.index({ number: 1 }, { unique: true });
tripSchema.index({ vehicleId: 1 }, { unique: true, partialFilterExpression: { active: true } });
tripSchema.index({ trailerId: 1 }, { unique: true, partialFilterExpression: { active: true, trailerId: { $exists: true } } });
tripSchema.index({ driverId: 1 }, { unique: true, partialFilterExpression: { active: true, driverId: { $exists: true } } });
tripSchema.index({ driverId: 1, endedAt: 1, settlementId: 1 });
tripSchema.index({ updatedAt: 1 });
// Open trips on the dashboards, and the paged list, newest first.
tripSchema.index({ active: 1 });
tripSchema.index({ startsAfterTripId: 1 }, { sparse: true });
tripSchema.index({ createdAt: -1 });

export const Trip = opsModel('Trip', tripSchema);

/** Trips waiting for a driver settlement: ended, or cancelled after cash was paid or spent on them. */
export const TO_SETTLE = { settlementId: { $exists: false }, $or: [{ endedAt: { $exists: true } }, { settleAfterCancel: true }] };
