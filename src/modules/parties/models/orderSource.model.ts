import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { masterSchema, masterModel } from '../../../core/masters/schema.js';

const orderSourceSchema = masterSchema({
  ...codeNameFields,
  referenceRequired: { type: Boolean, default: false },
});
uniqueIndex(orderSourceSchema, { code: 1 });

export const OrderSource = masterModel('OrderSource', orderSourceSchema);
