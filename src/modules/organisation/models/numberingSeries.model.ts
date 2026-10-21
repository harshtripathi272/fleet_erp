import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, masterSchema, masterModel } from '../../../core/masters/schema.js';

export const RESET_POLICIES = ['never', 'yearly', 'monthly'] as const;

const numberingSeriesSchema = masterSchema({
  ...codeNameFields,
  entity: { type: String, required: true },
  branchId: { type: ObjectId, ref: 'Branch' },
  prefix: { type: String, default: '' },
  pattern: { type: String, required: true },
  padding: { type: Number, min: 1, max: 10, default: 4 },
  resetPolicy: { type: String, enum: RESET_POLICIES, default: 'yearly' },
  nextNumber: { type: Number, min: 1, default: 1 },
  lastResetKey: String,
});
uniqueIndex(numberingSeriesSchema, { code: 1 });
/** One active series per entity (and branch). */
numberingSeriesSchema.index({ entity: 1, branchId: 1 }, { unique: true, partialFilterExpression: { status: 'active' } });

export const NumberingSeries = masterModel('NumberingSeries', numberingSeriesSchema);
