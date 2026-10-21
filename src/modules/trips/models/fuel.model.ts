import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, masterSchema, masterModel } from '../../../core/masters/schema.js';

const fuelTypeSchema = masterSchema({
  ...codeNameFields,
  unitId: { type: ObjectId, ref: 'Unit', required: true },
  densityKgPerL: Number,
});
uniqueIndex(fuelTypeSchema, { code: 1 });
export const FuelType = masterModel('FuelType', fuelTypeSchema);

/** km per litre for a vehicle type or a vehicle model, loaded and empty, plus a safety reserve. */
const fuelNormSchema = masterSchema({
  vehicleTypeId: { type: ObjectId, ref: 'VehicleType' },
  vehicleModelId: { type: ObjectId, ref: 'VehicleModel' },
  kmPerLLoaded: { type: Number, required: true },
  kmPerLEmpty: { type: Number, required: true },
  reservePercent: { type: Number, min: 0, max: 50, default: 5 },
});
fuelNormSchema.index({ vehicleTypeId: 1 }, { unique: true, partialFilterExpression: { vehicleTypeId: { $type: 'objectId' }, status: 'active' } });
fuelNormSchema.index({ vehicleModelId: 1 }, { unique: true, partialFilterExpression: { vehicleModelId: { $type: 'objectId' }, status: 'active' } });
export const FuelNorm = masterModel('FuelNorm', fuelNormSchema);
