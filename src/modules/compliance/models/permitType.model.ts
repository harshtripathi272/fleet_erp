import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, masterSchema, masterModel } from '../../../core/masters/schema.js';

const permitTypeSchema = masterSchema({
  ...codeNameFields,
  issuingAuthority: String,
  countryIds: { type: [{ type: ObjectId, ref: 'Country' }], required: true },
  validityDays: { type: Number, min: 1, max: 3650 },
  documentTypeId: { type: ObjectId, ref: 'DocumentType' },
});
uniqueIndex(permitTypeSchema, { code: 1 });

export const PermitType = masterModel('PermitType', permitTypeSchema);
