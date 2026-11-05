import { Schema } from 'mongoose';
import { opsModel } from './model.js';
import { ObjectId, moneySchema, schemaOptions } from '../../../core/masters/schema.js';

export const DESKS = ['owner', 'operations', 'finance', 'driver', 'viewer'] as const;
export const VIA = ['app', 'whatsapp'] as const;
export const REQUEST_STATUSES = ['pending', 'owner', 'approved', 'issued', 'rejected', 'cancelled'] as const;
export const OPEN_REQUEST = ['pending', 'owner', 'approved'];

const approvalLevelSchema = new Schema({
  level: Number,
  thread: String,
  label: String,
  approverRoleKey: String,
  approverUserId: { type: ObjectId, ref: 'User' },
  fallbackResource: String,
  channels: [String],
  escalateAfterHours: Number,
  escalatedAt: Date,
  decidedBy: { type: ObjectId, ref: 'User' },
  decidedByName: String,
  decidedAt: Date,
}, { _id: false });

/** Who must approve, from the company's approval policy at the time the item was raised. */
export const approvalSchema = new Schema({
  policyId: { type: ObjectId, ref: 'ApprovalPolicy' },
  levels: { type: [approvalLevelSchema], default: [] },
  current: { type: Number, default: 0 },
  escalateAt: Date,
  requireReasonAboveBudget: Boolean,
}, { _id: false });

const decisionSchema = new Schema({
  desk: { type: String, enum: DESKS, required: true },
  userId: { type: ObjectId, ref: 'User' },
  name: String,
  what: { type: String, enum: ['requested', 'approved', 'sent to owner', 'escalated', 'rejected', 'issued', 'cancelled'], required: true },
  at: { type: Date, required: true },
  note: String,
  via: { type: String, enum: VIA, default: 'app' },
}, { _id: false });

/**
 * Fuel (litres) or a cash advance for a trip. Pending goes to Finance; above the suggestion it then
 * goes to the owner; approved is paid out by Finance. `baseAmountMinor` is the advance in the
 * company's base currency at the rate on the day it was paid, for the driver's account.
 */
const fundRequestSchema = new Schema<any>({
  number: { type: String, required: true },
  tripId: { type: ObjectId, ref: 'Trip', required: true },
  kind: { type: String, enum: ['fuel', 'cash'], required: true },
  litres: { type: Number, min: 0 },
  amount: { type: moneySchema, default: undefined },
  /** Litres for fuel; base-currency minor units for cash. */
  suggested: { type: Number, min: 0, required: true },
  overBudget: { type: Boolean, default: false },
  reason: String,
  status: { type: String, enum: REQUEST_STATUSES, default: 'pending' },
  approval: { type: approvalSchema, default: undefined },
  trail: { type: [decisionSchema], default: [] },
  custom: { type: Schema.Types.Mixed, default: undefined },
  paymentMethodId: { type: ObjectId, ref: 'PaymentMethod' },
  medium: String,
  reference: String,
  station: String,
  issuedAt: Date,
  baseAmountMinor: Number,
  rate: Number,
  createdBy: { type: ObjectId, ref: 'User' },
  updatedBy: { type: ObjectId, ref: 'User' },
}, schemaOptions);
fundRequestSchema.index({ number: 1 }, { unique: true });
fundRequestSchema.index({ tripId: 1, status: 1 });
fundRequestSchema.index({ updatedAt: 1 });
// The approval and payment queues (by status, oldest first), and the paged list, newest first.
fundRequestSchema.index({ status: 1, createdAt: 1 });
fundRequestSchema.index({ createdAt: -1 });
// The escalation job: requests whose level has run out of time.
fundRequestSchema.index({ status: 1, 'approval.escalateAt': 1 });

export const FundRequest = opsModel('FundRequest', fundRequestSchema);

/** Where a truck is and how much fuel it carries. Maintained by trips; Operations can correct it. */
const vehicleStateSchema = new Schema<any>({
  vehicleId: { type: ObjectId, ref: 'Vehicle', required: true },
  placeId: { type: ObjectId, ref: 'Place' },
  fuelL: { type: Number, min: 0, default: 0 },
  updatedBy: { type: ObjectId, ref: 'User' },
}, schemaOptions);
vehicleStateSchema.index({ vehicleId: 1 }, { unique: true });
vehicleStateSchema.index({ updatedAt: 1 });

export const VehicleState = opsModel('VehicleState', vehicleStateSchema);
