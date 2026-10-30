import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { masterSchema, masterModel } from '../../../core/masters/schema.js';

const currencySchema = masterSchema({
  ...codeNameFields,
  symbol: String,
  minorUnits: { type: Number, min: 0, max: 4, default: 2 },
});
uniqueIndex(currencySchema, { code: 1 });

export const Currency = masterModel('Currency', currencySchema);
