import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, masterSchema, masterModel } from '../../../core/masters/schema.js';

const provinceSchema = masterSchema({
  ...codeNameFields,
  countryId: { type: ObjectId, ref: 'Country', required: true, index: true },
});
uniqueIndex(provinceSchema, { countryId: 1, code: 1 });

export const Province = masterModel('Province', provinceSchema);
