import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, masterSchema, masterModel } from '../../../core/masters/schema.js';

export const AXLE_CONFIGURATIONS = ['4x2', '4x4', '6x2', '6x4', '6x6', '8x4', '8x2'] as const;

const vehicleModelSchema = masterSchema({
  ...codeNameFields,
  makeId: { type: ObjectId, ref: 'VehicleMake', required: true, index: true },
  vehicleTypeId: { type: ObjectId, ref: 'VehicleType' },
  axleConfiguration: { type: String, enum: AXLE_CONFIGURATIONS },
  engine: String,
  grossVehicleMassKg: Number,
  grossCombinationMassKg: Number,
  tankCapacityL: Number,
  kmPerLLoaded: Number,
  kmPerLEmpty: Number,
});
uniqueIndex(vehicleModelSchema, { code: 1 });
uniqueIndex(vehicleModelSchema, { makeId: 1, name: 1 });

export const VehicleModel = masterModel('VehicleModel', vehicleModelSchema);
