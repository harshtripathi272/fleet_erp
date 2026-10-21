import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { masterSchema, masterModel } from '../../../core/masters/schema.js';

export const DIMENSIONS = ['mass', 'volume', 'count', 'length', 'time', 'area'] as const;

const unitSchema = masterSchema({
  ...codeNameFields,
  symbol: String,
  dimension: { type: String, enum: DIMENSIONS, required: true },
  decimals: { type: Number, min: 0, max: 6, default: 2 },
});
uniqueIndex(unitSchema, { code: 1 });

export const Unit = masterModel('Unit', unitSchema);
