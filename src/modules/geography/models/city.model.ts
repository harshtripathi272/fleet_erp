import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, locationSchema, masterSchema, masterModel } from '../../../core/masters/schema.js';

const citySchema = masterSchema({
  ...codeNameFields,
  provinceId: { type: ObjectId, ref: 'Province', required: true, index: true },
  countryId: { type: ObjectId, ref: 'Country', required: true, index: true },
  location: locationSchema,
});
uniqueIndex(citySchema, { code: 1 });
uniqueIndex(citySchema, { provinceId: 1, name: 1 });

export const City = masterModel('City', citySchema);
