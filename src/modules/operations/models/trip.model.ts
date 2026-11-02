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
}, { strict: 'throw' });

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
  /** The latest position. `source` says where it came from; `simulator` positions are a demo, not the truck. */
  tracking: { type: new Schema({ km: Number, speed: Number, heading: Number, at: Date, source: { type: String, enum: ARRIVAL_SOURCES } }, { _id: false }), default: undefined },
  settlementId: { type: ObjectId, ref: 'Settlement' },
  active: { type: Boolean, default: true },
  createdBy: { type: ObjectId, ref: 'User' },
  updatedBy: { type: ObjectId, ref: 'User' },
}, schemaOptions);

tripSchema.index({ number: 1 }, { unique: true });
tripSchema.index({ vehicleId: 1 }, { unique: true, partialFilterExpression: { active: true } });
tripSchema.index({ trailerId: 1 }, { unique: true, partialFilterExpression: { active: true, trailerId: { $exists: true } } });
tripSchema.index({ driverId: 1 }, { unique: true, partialFilterExpression: { active: true, driverId: { $exists: true } } });
tripSchema.index({ driverId: 1, endedAt: 1, settlementId: 1 });
tripSchema.index({ updatedAt: 1 });

export const Trip = opsModel('Trip', tripSchema);
