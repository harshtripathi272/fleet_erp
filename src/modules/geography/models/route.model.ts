import { Schema } from 'mongoose';
import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, masterSchema, moneySchema, masterModel } from '../../../core/masters/schema.js';

export const STOP_KINDS = ['start', 'load', 'via', 'border', 'offload', 'end'] as const;

const stopSchema = new Schema({
  placeId: { type: ObjectId, ref: 'Place', required: true },
  kind: { type: String, enum: STOP_KINDS, required: true },
  legKm: { type: Number, required: true, min: 0 },
  borderPostId: { type: ObjectId, ref: 'BorderPost' },
  loaded: { type: Boolean, default: false },
}, { _id: false });

const routeSchema = masterSchema({
  ...codeNameFields,
  stops: { type: [stopSchema], required: true },
  standardDays: { type: Number, min: 0, max: 60 },
  fuelBudgetL: { type: Number, min: 0 },
  cashBudget: moneySchema,
  totalKm: { type: Number, default: 0 },
  loadedKm: { type: Number, default: 0 },
  emptyKm: { type: Number, default: 0 },
});
uniqueIndex(routeSchema, { code: 1 });
routeSchema.index({ 'stops.placeId': 1 });

export const Route = masterModel('Route', routeSchema);
