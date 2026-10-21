import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, masterSchema, masterModel } from '../../../core/masters/schema.js';

const licenceClassSchema = masterSchema({
  ...codeNameFields,
  countryId: { type: ObjectId, ref: 'Country', required: true },
  minimumAge: { type: Number, min: 16, max: 30 },
});
uniqueIndex(licenceClassSchema, { countryId: 1, code: 1 });

export const LicenceClass = masterModel('LicenceClass', licenceClassSchema);
