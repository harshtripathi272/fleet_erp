import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { masterSchema, masterModel } from '../../../core/masters/schema.js';
import { PRICING_BASES } from './productGroup.model.js';

const loadTypeSchema = masterSchema({
  ...codeNameFields,
  pricingBasis: { type: String, enum: PRICING_BASES },
  multiDropAllowed: { type: Boolean, default: false },
});
uniqueIndex(loadTypeSchema, { code: 1 });

export const LoadType = masterModel('LoadType', loadTypeSchema);
