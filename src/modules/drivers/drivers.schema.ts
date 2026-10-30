import { z } from 'zod';
import { address, baseShape, code, email, idList, integer, isoDate, money, name, objectId, percent, phone, text, toUpdateSchema } from '../../core/masters/zod.js';
import { BLOOD_GROUPS, EMPLOYMENT_TYPES, MARITAL_STATUSES, PAYOUT_METHODS } from './models/driver.model.js';
import { RECOVERY_KINDS } from './models/recoveryRule.model.js';

const docNumber = z.string().trim().toUpperCase().regex(/^[A-Z0-9/ -]{3,30}$/, '3-30 letters, digits, "/", "-" or spaces');
const person = z.strictObject({ name: text(120), relation: text(60).optional(), phone: phone.optional(), address: text(300).optional() });

export const licenceClassShape = {
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9+-]{1,10}$/, 'e.g. C1, EC, HGV'),
  name, description: text(500).optional(),
  countryId: objectId,
  minimumAge: integer(16, 30).optional(),
  ...baseShape,
};

export const driverShape = {
  code: code.optional(),
  firstName: text(60),
  lastName: text(60),
  photoUrl: z.url().max(2000).optional(),
  dateOfBirth: isoDate.optional(),
  maritalStatus: z.enum(MARITAL_STATUSES).optional(),
  religion: text(60).optional(),
  bloodGroup: z.enum(BLOOD_GROUPS).optional(),
  nationalId: z.strictObject({ countryId: objectId, typeKey: z.string().regex(/^[a-z][a-z0-9_]{0,29}$/).optional(), number: docNumber }).optional(),
  passport: z.strictObject({ number: docNumber, countryId: objectId.optional(), issueDate: isoDate.optional(), expiryDate: isoDate.optional() }).optional(),
  phone,
  whatsapp: phone.optional(),
  email: email.optional(),
  address: address.optional(),
  landmark: text(200).optional(),
  licence: z.strictObject({
    number: docNumber,
    classIds: idList(10).optional(),
    issuedByCountryId: objectId.optional(),
    issuingAuthority: text(100).optional(),
    issueDate: isoDate.optional(),
    expiryDate: isoDate,
  }).optional(),
  professionalPermit: z.strictObject({ number: docNumber, expiryDate: isoDate.optional() }).optional(),
  medicalExpiryDate: isoDate.optional(),
  qualification: text(120).optional(),
  experienceYears: z.number().min(0).max(60).optional(),
  experienceDetails: text(1000).optional(),
  references: z.array(person).max(5).optional(),
  emergencyContact: person.optional(),
  homeBranchId: objectId.optional(),
  fleetManagerUserId: objectId.optional(),
  joinedOn: isoDate.optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  taxIds: z.strictObject({ tpin: docNumber.optional(), napsa: docNumber.optional(), nhima: docNumber.optional() }).optional(),
  payout: z.strictObject({
    method: z.enum(PAYOUT_METHODS),
    provider: text(60).optional(),
    accountName: text(120).optional(),
    accountNumber: z.string().trim().regex(/^[A-Za-z0-9 +-]{4,40}$/, '4-40 letters, digits, spaces, "+" or "-"').optional(),
  }).optional(),
  openingBalance: money.optional(),
  blacklisted: z.boolean().optional(),
  blacklistReason: text(500).optional(),
  assignedVehicleId: objectId.optional(),
  ...baseShape,
};

export const recoveryRuleShape = {
  code, name, description: text(500).optional(),
  kind: z.enum(RECOVERY_KINDS),
  maxPercentPerSettlement: percent.optional(),
  maxAmountPerSettlement: money.optional(),
  requiresApproval: z.boolean().optional(),
  approvalPolicyId: objectId.optional(),
  ...baseShape,
};

export const createLicenceClassSchema = z.strictObject(licenceClassShape);
export const updateLicenceClassSchema = toUpdateSchema(licenceClassShape);
export const createDriverSchema = z.strictObject(driverShape);
export const updateDriverSchema = toUpdateSchema(driverShape);
export const createRecoveryRuleSchema = z.strictObject(recoveryRuleShape);
export const updateRecoveryRuleSchema = toUpdateSchema(recoveryRuleShape);
