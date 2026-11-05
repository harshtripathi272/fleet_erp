import { Schema } from 'mongoose';
import { uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, masterSchema, moneySchema, masterModel } from '../../../core/masters/schema.js';

export const OWNERSHIP = ['own', 'hired', 'leased'] as const;
export const OPERATIONAL_STATUSES = ['available', 'on_trip', 'in_workshop', 'breakdown', 'impounded', 'sold'] as const;

const datedAmount = new Schema({ date: { type: Date, required: true }, amount: moneySchema }, { _id: false });

/** One truck. Columns match the client's Vehicle Master and TruckMaster sheets. */
const vehicleSchema = masterSchema({
  code: { type: String, required: true, trim: true },
  registrationNumber: { type: String, required: true },
  /** Plate without spaces or punctuation, so "ALC 4821" and "ALC4821" count as the same truck. */
  registrationKey: { type: String, required: true },
  vin: String,
  engineNumber: String,
  makeId: { type: ObjectId, ref: 'VehicleMake', required: true },
  modelId: { type: ObjectId, ref: 'VehicleModel' },
  vehicleTypeId: { type: ObjectId, ref: 'VehicleType', required: true, index: true },
  year: Number,
  colour: String,
  ownership: { type: String, enum: OWNERSHIP, default: 'own' },
  ownerPartyId: { type: ObjectId, ref: 'Party' },
  financierPartyId: { type: ObjectId, ref: 'Party' },
  dealerPartyId: { type: ObjectId, ref: 'Party' },
  homeBranchId: { type: ObjectId, ref: 'Branch', index: true },
  /** Moves on when a trip ends and when a workshop records a reading. */
  odometerKm: { type: Number, min: 0 },
  engineHours: { type: Number, min: 0 },
  tankCapacityL: Number,
  fuelTypeId: { type: ObjectId, ref: 'FuelType' },
  kmPerLLoaded: Number,
  kmPerLEmpty: Number,
  tareKg: Number,
  payloadKg: Number,
  gpsDeviceId: String,
  gpsVendor: String,
  fuelCardNumber: String,
  operationalStatus: { type: String, enum: OPERATIONAL_STATUSES, default: 'available', index: true },
  registrationDate: Date,
  purchase: { type: datedAmount, default: undefined },
  sale: { type: datedAmount, default: undefined },
  regulatorRefs: { type: [{ _id: false, authority: String, number: String }], default: undefined },
  /** Maintained by the pairing endpoints. */
  currentTrailerId: { type: ObjectId, ref: 'Trailer' },
});
uniqueIndex(vehicleSchema, { code: 1 });
uniqueIndex(vehicleSchema, { registrationKey: 1 });
uniqueIndex(vehicleSchema, { vin: 1 }, { vin: { $type: 'string' } });
uniqueIndex(vehicleSchema, { engineNumber: 1 }, { engineNumber: { $type: 'string' } });

export const Vehicle = masterModel('Vehicle', vehicleSchema);
