import { uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, masterSchema, masterModel } from '../../../core/masters/schema.js';
import { OPERATIONAL_STATUSES, OWNERSHIP } from './vehicle.model.js';

const trailerSchema = masterSchema({
  code: { type: String, required: true, trim: true },
  registrationNumber: { type: String, required: true },
  /** Plate without spaces or punctuation, so "ALC 4821" and "ALC4821" count as the same truck. */
  registrationKey: { type: String, required: true },
  chassisNumber: String,
  trailerTypeId: { type: ObjectId, ref: 'TrailerType', required: true, index: true },
  make: String,
  model: String,
  year: Number,
  axles: Number,
  tareKg: Number,
  capacityKg: Number,
  capacityL: Number,
  compartments: { type: [{ _id: false, number: Number, capacityL: Number }], default: undefined },
  ownership: { type: String, enum: OWNERSHIP, default: 'own' },
  ownerPartyId: { type: ObjectId, ref: 'Party' },
  homeBranchId: { type: ObjectId, ref: 'Branch' },
  operationalStatus: { type: String, enum: OPERATIONAL_STATUSES, default: 'available' },
  /** Maintained by the pairing endpoints. */
  currentVehicleId: { type: ObjectId, ref: 'Vehicle' },
});
uniqueIndex(trailerSchema, { code: 1 });
uniqueIndex(trailerSchema, { registrationKey: 1 });
uniqueIndex(trailerSchema, { chassisNumber: 1 }, { chassisNumber: { $type: 'string' } });

export const Trailer = masterModel('Trailer', trailerSchema);
