import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, masterSchema, masterModel } from '../../../core/masters/schema.js';

const vehicleMakeSchema = masterSchema({ ...codeNameFields, countryId: { type: ObjectId, ref: 'Country' } });
uniqueIndex(vehicleMakeSchema, { code: 1 });
uniqueIndex(vehicleMakeSchema, { name: 1 });

export const VehicleMake = masterModel('VehicleMake', vehicleMakeSchema);
