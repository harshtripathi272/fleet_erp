import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, masterSchema, masterModel } from '../../../core/masters/schema.js';

/** Expected fuel and cash for a route, optionally per vehicle type. */
const tripBudgetSchema = masterSchema({
  ...codeNameFields,
  routeId: { type: ObjectId, ref: 'Route', required: true },
  vehicleTypeId: { type: ObjectId, ref: 'VehicleType' },
  currencyId: { type: ObjectId, ref: 'Currency', required: true },
  fuelL: Number,
  cashItems: { type: [{ _id: false, expenseItemId: { type: ObjectId, ref: 'ExpenseItem', required: true }, amountMinor: { type: Number, required: true, min: 0 } }], default: [] },
  totalCashMinor: { type: Number, default: 0 },
});
uniqueIndex(tripBudgetSchema, { code: 1 });
tripBudgetSchema.index({ routeId: 1, vehicleTypeId: 1 }, { unique: true, partialFilterExpression: { status: 'active' } });
export const TripBudget = masterModel('TripBudget', tripBudgetSchema);
