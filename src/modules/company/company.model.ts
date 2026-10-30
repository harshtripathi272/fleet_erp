import { Schema, model } from 'mongoose';
import { ObjectId, schemaOptions } from '../../core/masters/schema.js';

/** The transporter using this deployment. Exactly one document. */
const companySchema = new Schema<any>({
  /** Fixed value with a unique index, so only one company document can exist. */
  singleton: { type: String, default: 'company', enum: ['company'] },
  legalName: { type: String, required: true, trim: true },
  tradingName: String,
  registrationNumber: String,
  taxId: String,
  countryId: { type: ObjectId, ref: 'Country' },
  baseCurrencyId: { type: ObjectId, ref: 'Currency' },
  timezone: { type: String, default: 'Africa/Lusaka' },
  fiscalYearStartMonth: { type: Number, min: 1, max: 12, default: 1 },
  dateFormat: { type: String, enum: ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'], default: 'DD/MM/YYYY' },
  allowSelfRegistration: { type: Boolean, default: true },
  modules: { type: [String], default: ['masters', 'trips'] },
  address: { line1: String, line2: String, city: String, postalCode: String },
  phone: String,
  email: String,
  website: String,
  logoUrl: String,
  updatedBy: { type: ObjectId, ref: 'User' },
}, { ...schemaOptions, minimize: true });
companySchema.index({ singleton: 1 }, { unique: true });

export const Company = model('Company', companySchema);
