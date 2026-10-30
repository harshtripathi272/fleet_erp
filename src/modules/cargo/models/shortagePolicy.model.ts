import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, masterSchema, moneySchema, masterModel } from '../../../core/masters/schema.js';

export const ALLOWANCE_KINDS = ['percent', 'absolute'] as const;
export const MEASURED_AT = ['reference_temperature', 'observed'] as const;
export const BEARERS = ['driver', 'company', 'shared'] as const;

const shortagePolicySchema = masterSchema({
  ...codeNameFields,
  productId: { type: ObjectId, ref: 'Product' },
  productGroupId: { type: ObjectId, ref: 'ProductGroup' },
  allowanceKind: { type: String, enum: ALLOWANCE_KINDS, required: true },
  allowanceValue: { type: Number, required: true, min: 0 },
  measuredAt: { type: String, enum: MEASURED_AT, default: 'reference_temperature' },
  pricePerUnit: moneySchema,
  bearer: { type: String, enum: BEARERS, default: 'driver' },
  driverSharePercent: { type: Number, min: 0, max: 100 },
  approvalPolicyId: { type: ObjectId, ref: 'ApprovalPolicy' },
});
uniqueIndex(shortagePolicySchema, { code: 1 });
shortagePolicySchema.index({ productId: 1 }, { unique: true, partialFilterExpression: { productId: { $type: 'objectId' }, status: 'active' } });
shortagePolicySchema.index({ productGroupId: 1 }, { unique: true, partialFilterExpression: { productGroupId: { $type: 'objectId' }, status: 'active' } });

export const ShortagePolicy = masterModel('ShortagePolicy', shortagePolicySchema);
