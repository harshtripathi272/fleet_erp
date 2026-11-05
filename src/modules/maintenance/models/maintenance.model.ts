import { Schema } from 'mongoose';
import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, masterModel, masterSchema, moneySchema } from '../../../core/masters/schema.js';
import { opsModel } from '../../operations/models/model.js';

/** A service a truck type or one truck needs: every so many km, days and/or engine hours, whichever comes first. */
const servicePlanSchema = masterSchema({
  ...codeNameFields,
  vehicleTypeId: { type: ObjectId, ref: 'VehicleType', index: true },
  vehicleId: { type: ObjectId, ref: 'Vehicle', index: true },
  everyKm: { type: Number, min: 1 },
  everyDays: { type: Number, min: 1 },
  everyEngineHours: { type: Number, min: 1 },
  includes: String,
});
uniqueIndex(servicePlanSchema, { code: 1 });
export const ServicePlan = masterModel('ServicePlan', servicePlanSchema);

export const WORK_ORDER_STAGES = ['open', 'in_workshop', 'done'] as const;
export const WORK_ORDER_SOURCES = ['service', 'defect', 'manual'] as const;

const partLineSchema = new Schema({
  name: { type: String, required: true, trim: true },
  partNumber: String,
  quantity: { type: Number, required: true, min: 0 },
  unitCost: { type: moneySchema, required: true },
}, { _id: false });

/** One job on a truck: a due service, a defect the driver reported, or anything else the office opens. */
const workOrderSchema = masterSchema({
  number: { type: String, required: true, trim: true },
  vehicleId: { type: ObjectId, ref: 'Vehicle', required: true },
  source: { type: String, enum: WORK_ORDER_SOURCES, default: 'manual' },
  servicePlanId: { type: ObjectId, ref: 'ServicePlan' },
  description: String,
  workshopPartyId: { type: ObjectId, ref: 'Party' },
  stage: { type: String, enum: WORK_ORDER_STAGES, default: 'open' },
  stopsTruck: { type: Boolean, default: true },
  odometerKm: { type: Number, min: 0 },
  engineHours: { type: Number, min: 0 },
  startedAt: Date,
  endedAt: Date,
  labour: { type: moneySchema, default: undefined },
  parts: { type: [partLineSchema], default: undefined },
  /** Labour and parts in the company's base currency, for cost per truck. */
  costBaseMinor: { type: Number, default: 0 },
  reportedByDriverId: { type: ObjectId, ref: 'Driver' },
});
uniqueIndex(workOrderSchema, { number: 1 });
workOrderSchema.index({ vehicleId: 1, stage: 1, stopsTruck: 1 });
workOrderSchema.index({ vehicleId: 1, servicePlanId: 1, stage: 1, endedAt: -1 });
workOrderSchema.index({ stage: 1, endedAt: -1 });
export const WorkOrder = masterModel('WorkOrder', workOrderSchema);

export const TYRE_ACTIONS = ['fitted', 'rotated', 'replaced'] as const;

/** One thing done to a tyre on a truck: which position, at what reading, and what it cost. */
const tyreRecordSchema = masterSchema({
  vehicleId: { type: ObjectId, ref: 'Vehicle', required: true, index: true },
  position: { type: String, required: true, trim: true },
  fromPosition: String,
  action: { type: String, enum: TYRE_ACTIONS, required: true },
  serialNumber: String,
  odometerKm: { type: Number, min: 0 },
  at: { type: Date, required: true },
  cost: { type: moneySchema, default: undefined },
  costBaseMinor: { type: Number, default: 0 },
});
tyreRecordSchema.index({ at: -1 });
export const TyreRecord = masterModel('TyreRecord', tyreRecordSchema);

/** Where a plan's counting starts on a truck before its first service, and which reminders have gone. */
const serviceStateSchema = new Schema<any>({
  vehicleId: { type: ObjectId, ref: 'Vehicle', required: true },
  planId: { type: ObjectId, ref: 'ServicePlan', required: true },
  baseKm: Number,
  baseHours: Number,
  baseAt: { type: Date, required: true },
  remindedDueFor: String,
  remindedOverdueFor: String,
}, { timestamps: true, versionKey: false });
serviceStateSchema.index({ vehicleId: 1, planId: 1 }, { unique: true });
export const ServiceState = opsModel('ServiceState', serviceStateSchema);
