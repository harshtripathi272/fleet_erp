import { Schema } from 'mongoose';
import { uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, addressSchema, masterSchema, moneySchema, subdoc, masterModel } from '../../../core/masters/schema.js';

export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;
export const MARITAL_STATUSES = ['single', 'married', 'divorced', 'widowed', 'other'] as const;
export const EMPLOYMENT_TYPES = ['permanent', 'contract', 'casual'] as const;
export const PAYOUT_METHODS = ['bank', 'mobile_money', 'cash'] as const;

const person = new Schema({ name: { type: String, required: true }, relation: String, phone: String, address: String }, { _id: false });

/** One driver. Fields cover every column of the client's Driver Master sheet. */
const driverSchema = masterSchema({
  code: { type: String, required: true, trim: true },
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  name: { type: String, required: true },
  photoUrl: String,
  dateOfBirth: Date,
  maritalStatus: { type: String, enum: MARITAL_STATUSES },
  religion: String,
  bloodGroup: { type: String, enum: BLOOD_GROUPS },
  nationalId: subdoc({ countryId: { type: ObjectId, ref: 'Country', required: true }, typeKey: String, number: { type: String, required: true } }),
  passport: subdoc({ number: { type: String, required: true }, countryId: { type: ObjectId, ref: 'Country' }, issueDate: Date, expiryDate: Date }),
  phone: { type: String, required: true },
  whatsapp: String,
  email: String,
  address: { type: addressSchema, default: undefined },
  landmark: String,
  licence: subdoc({
    number: { type: String, required: true },
    classIds: { type: [{ type: ObjectId, ref: 'LicenceClass' }], default: undefined },
    issuedByCountryId: { type: ObjectId, ref: 'Country' },
    issuingAuthority: String,
    issueDate: Date,
    expiryDate: { type: Date, required: true },
  }),
  professionalPermit: subdoc({ number: { type: String, required: true }, expiryDate: Date }),
  medicalExpiryDate: Date,
  qualification: String,
  experienceYears: { type: Number, min: 0, max: 60 },
  experienceDetails: String,
  references: { type: [person], default: undefined },
  emergencyContact: { type: person, default: undefined },
  homeBranchId: { type: ObjectId, ref: 'Branch', index: true },
  fleetManagerUserId: { type: ObjectId, ref: 'User' },
  joinedOn: Date,
  employmentType: { type: String, enum: EMPLOYMENT_TYPES },
  taxIds: subdoc({ tpin: String, napsa: String, nhima: String }),
  payout: subdoc({ method: { type: String, enum: PAYOUT_METHODS, required: true }, provider: String, accountName: String, accountNumber: String }),
  openingBalance: moneySchema,
  blacklisted: { type: Boolean, default: false },
  blacklistReason: String,
  assignedVehicleId: { type: ObjectId, ref: 'Vehicle' },
});
uniqueIndex(driverSchema, { code: 1 });
uniqueIndex(driverSchema, { 'nationalId.countryId': 1, 'nationalId.number': 1 }, { 'nationalId.number': { $type: 'string' } });
uniqueIndex(driverSchema, { 'licence.number': 1 }, { 'licence.number': { $type: 'string' } });
uniqueIndex(driverSchema, { 'passport.number': 1 }, { 'passport.number': { $type: 'string' } });
/** A truck is assigned to at most one active driver. */
driverSchema.index({ assignedVehicleId: 1 }, { unique: true, partialFilterExpression: { assignedVehicleId: { $type: 'objectId' }, status: 'active' } });
driverSchema.index({ 'licence.expiryDate': 1 });

export const Driver = masterModel('Driver', driverSchema);
