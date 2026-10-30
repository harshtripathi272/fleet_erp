import { ObjectId, masterSchema, masterModel } from '../../../core/masters/schema.js';

const unitConversionSchema = masterSchema({
  fromUnitId: { type: ObjectId, ref: 'Unit', required: true },
  toUnitId: { type: ObjectId, ref: 'Unit', required: true },
  factor: { type: Number, required: true },
  productId: { type: ObjectId, ref: 'Product' },
});
unitConversionSchema.index({ fromUnitId: 1, toUnitId: 1, productId: 1 }, { unique: true });

export const UnitConversion = masterModel('UnitConversion', unitConversionSchema);
