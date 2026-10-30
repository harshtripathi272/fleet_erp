import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, masterSchema, masterModel } from '../../../core/masters/schema.js';

export const COVERAGES = ['third_party', 'comprehensive', 'goods_in_transit', 'yellow_card', 'liability', 'other'] as const;

const insuranceTypeSchema = masterSchema({
  ...codeNameFields,
  coverage: { type: String, enum: COVERAGES, required: true },
  countryIds: { type: [{ type: ObjectId, ref: 'Country' }], default: undefined },
  documentTypeId: { type: ObjectId, ref: 'DocumentType' },
});
uniqueIndex(insuranceTypeSchema, { code: 1 });

export const InsuranceType = masterModel('InsuranceType', insuranceTypeSchema);
