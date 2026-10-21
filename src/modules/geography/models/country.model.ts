import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, masterSchema, masterModel } from '../../../core/masters/schema.js';

const countrySchema = masterSchema({
  ...codeNameFields,
  iso3: String,
  dialCode: String,
  currencyId: { type: ObjectId, ref: 'Currency' },
  drivingSide: { type: String, enum: ['left', 'right'] },
  timezones: { type: [String], default: undefined },
  idTypes: { type: [{ _id: false, key: String, label: String, pattern: String }], default: undefined },
});
uniqueIndex(countrySchema, { code: 1 });
uniqueIndex(countrySchema, { iso3: 1 }, { iso3: { $type: 'string' } });

export const Country = masterModel('Country', countrySchema);
