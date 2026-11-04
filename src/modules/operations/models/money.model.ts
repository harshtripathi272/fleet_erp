import { Schema } from 'mongoose';
import { opsModel } from './model.js';
import { ObjectId, moneySchema, schemaOptions } from '../../../core/masters/schema.js';
import { DESKS, approvalSchema } from './funding.model.js';

/** A trip cost with its receipt, recorded against a driver and approved or rejected by Finance. */
const expenseSchema = new Schema<any>({
  number: { type: String, required: true },
  tripId: { type: ObjectId, ref: 'Trip' },
  driverId: { type: ObjectId, ref: 'Driver', required: true },
  categoryId: { type: ObjectId, ref: 'ExpenseCategory', required: true },
  amount: { type: moneySchema, required: true },
  baseAmountMinor: { type: Number, required: true },
  rate: Number,
  receiptNo: String,
  docId: { type: ObjectId, ref: 'DriverDocument' },
  note: String,
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  approval: { type: approvalSchema, default: undefined },
  recordedByDesk: { type: String, enum: DESKS },
  decidedAt: Date,
  decidedBy: { type: ObjectId, ref: 'User' },
  reason: String,
  at: { type: Date, required: true },
  createdBy: { type: ObjectId, ref: 'User' },
  updatedBy: { type: ObjectId, ref: 'User' },
}, schemaOptions);
expenseSchema.index({ number: 1 }, { unique: true });
expenseSchema.index({ driverId: 1, status: 1 });
expenseSchema.index({ tripId: 1 });
expenseSchema.index({ updatedAt: 1 });
// Expenses waiting for a decision, oldest first, and the paged list.
expenseSchema.index({ status: 1, at: 1 });
expenseSchema.index({ at: -1 });

export const Expense = opsModel('Expense', expenseSchema);

/**
 * A periodic settlement of one driver across several closed trips. Amounts are in the base
 * currency's minor units. Positive `cashMinor`: the driver handed cash back; negative: paid to the driver.
 */
const settlementSchema = new Schema<any>({
  number: { type: String, required: true },
  driverId: { type: ObjectId, ref: 'Driver', required: true },
  tripIds: { type: [{ type: ObjectId, ref: 'Trip' }], required: true },
  from: { type: Date, required: true },
  to: { type: Date, required: true },
  currencyId: { type: ObjectId, ref: 'Currency', required: true },
  openingMinor: { type: Number, required: true },
  advancesMinor: { type: Number, required: true },
  expensesMinor: { type: Number, required: true },
  shortagesMinor: { type: Number, required: true },
  writeOffsMinor: { type: Number, default: 0 },
  cashMinor: { type: Number, required: true },
  closingMinor: { type: Number, required: true },
  note: String,
  postedAt: { type: Date, required: true },
  createdBy: { type: ObjectId, ref: 'User' },
  updatedBy: { type: ObjectId, ref: 'User' },
}, schemaOptions);
settlementSchema.index({ number: 1 }, { unique: true });
settlementSchema.index({ driverId: 1, postedAt: 1 });
settlementSchema.index({ updatedAt: 1 });

export const Settlement = opsModel('Settlement', settlementSchema);

/** Per-driver state outside the master: an open request to settle. */
const driverAccountSchema = new Schema<any>({
  driverId: { type: ObjectId, ref: 'Driver', required: true },
  settleRequestedAt: Date,
  settleRequestedByDesk: { type: String, enum: DESKS },
  settleRequestedBy: { type: ObjectId, ref: 'User' },
}, schemaOptions);
driverAccountSchema.index({ driverId: 1 }, { unique: true });
driverAccountSchema.index({ updatedAt: 1 });

export const DriverAccount = opsModel('DriverAccount', driverAccountSchema);

/** A customer's order naming trucks (and drivers) for a load. Accepted nominations become trips. */
const nominationSchema = new Schema<any>({
  number: { type: String, required: true },
  customerId: { type: ObjectId, ref: 'Party', required: true },
  orderSourceId: { type: ObjectId, ref: 'OrderSource' },
  reference: String,
  loadingPlaceId: { type: ObjectId, ref: 'Place', required: true },
  productId: { type: ObjectId, ref: 'Product' },
  qtyPerTruck: { type: Number, min: 0 },
  requiredDate: { type: Date, required: true },
  trucks: { type: [{ _id: false, vehicleId: { type: ObjectId, ref: 'Vehicle', required: true }, driverId: { type: ObjectId, ref: 'Driver' } }], default: [] },
  status: { type: String, enum: ['draft', 'sent', 'accepted', 'converted', 'cancelled'], default: 'draft' },
  note: String,
  sentAt: Date,
  acceptedAt: Date,
  tripIds: { type: [{ type: ObjectId, ref: 'Trip' }], default: [] },
  createdBy: { type: ObjectId, ref: 'User' },
  updatedBy: { type: ObjectId, ref: 'User' },
}, schemaOptions);
nominationSchema.index({ number: 1 }, { unique: true });
nominationSchema.index({ status: 1 });
nominationSchema.index({ updatedAt: 1 });

export const Nomination = opsModel('Nomination', nominationSchema);
