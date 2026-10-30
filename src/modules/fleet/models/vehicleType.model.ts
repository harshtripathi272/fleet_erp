import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, masterSchema, masterModel } from '../../../core/masters/schema.js';

export const VEHICLE_CATEGORIES = ['prime_mover', 'rigid', 'tipper', 'tanker_rigid', 'light_vehicle', 'bus', 'other'] as const;

const vehicleTypeSchema = masterSchema({
  ...codeNameFields,
  category: { type: String, enum: VEHICLE_CATEGORIES, required: true },
  towsTrailer: { type: Boolean, default: false },
  licenceClassIds: { type: [{ type: ObjectId, ref: 'LicenceClass' }], default: undefined },
  requiredDocumentTypeIds: { type: [{ type: ObjectId, ref: 'DocumentType' }], default: undefined },
});
uniqueIndex(vehicleTypeSchema, { code: 1 });

export const VehicleType = masterModel('VehicleType', vehicleTypeSchema);
