import { Schema } from 'mongoose';
import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, masterSchema, moneySchema, masterModel } from '../../../core/masters/schema.js';

export const PARTY_ROLES = ['customer', 'consignor', 'consignee', 'supplier', 'broker', 'clearing_agent', 'hired_transporter', 'insurer', 'financier', 'dealer', 'workshop'] as const;
export const CONTACT_RECEIVES = ['nominations', 'pods', 'invoices', 'statements'] as const;
export const ADDRESS_KINDS = ['billing', 'delivery', 'site', 'registered'] as const;

const contactSchema = new Schema({
  name: { type: String, required: true },
  jobTitle: String,
  phone: String,
  whatsapp: String,
  email: String,
  receives: { type: [String], default: undefined },
  isPrimary: { type: Boolean, default: false },
}, { _id: false });

const partyAddressSchema = new Schema({
  kind: { type: String, enum: ADDRESS_KINDS, required: true },
  line1: { type: String, required: true },
  line2: String,
  cityId: { type: ObjectId, ref: 'City' },
  postalCode: String,
  isDefault: { type: Boolean, default: false },
}, { _id: false });

const bankAccountSchema = new Schema({
  bankName: { type: String, required: true },
  accountName: { type: String, required: true },
  accountNumber: { type: String, required: true },
  branchCode: String,
  swift: String,
  currencyId: { type: ObjectId, ref: 'Currency' },
}, { _id: false });

/** One record for any company or person the business deals with; roles say how. */
const partySchema = masterSchema({
  ...codeNameFields,
  tradingName: String,
  roles: { type: [String], enum: PARTY_ROLES, required: true },
  taxId: String,
  registrationNumber: String,
  countryId: { type: ObjectId, ref: 'Country' },
  currencyId: { type: ObjectId, ref: 'Currency' },
  paymentTermsDays: { type: Number, min: 0, max: 365 },
  creditLimit: moneySchema,
  contacts: { type: [contactSchema], default: undefined },
  addresses: { type: [partyAddressSchema], default: undefined },
  bankAccounts: { type: [bankAccountSchema], default: undefined },
});
uniqueIndex(partySchema, { code: 1 });
uniqueIndex(partySchema, { countryId: 1, taxId: 1 }, { taxId: { $type: 'string' } });
partySchema.index({ roles: 1 });

export const Party = masterModel('Party', partySchema);
