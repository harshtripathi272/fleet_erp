import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, masterSchema, masterModel } from '../../../core/masters/schema.js';

export const PRICING_BASES = ['per_tonne', 'per_litre', 'per_km', 'per_trip', 'per_day', 'flat'] as const;

const productGroupSchema = masterSchema({
  ...codeNameFields,
  defaultUnitId: { type: ObjectId, ref: 'Unit' },
  pricingBasis: { type: String, enum: PRICING_BASES },
});
uniqueIndex(productGroupSchema, { code: 1 });

export const ProductGroup = masterModel('ProductGroup', productGroupSchema);
