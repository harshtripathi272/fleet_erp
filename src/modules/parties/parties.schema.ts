import { z } from 'zod';
import { baseShape, code, email, integer, money, name, objectId, phone, text, toUpdateSchema } from '../../core/masters/zod.js';
import { ADDRESS_KINDS, CONTACT_RECEIVES, PARTY_ROLES } from './models/party.model.js';

const unique = <T>(arr: T[]) => new Set(arr).size === arr.length;

const contact = z.strictObject({
  name: text(120),
  jobTitle: text(80).optional(),
  phone: phone.optional(),
  whatsapp: phone.optional(),
  email: email.optional(),
  receives: z.array(z.enum(CONTACT_RECEIVES)).max(4).refine(unique, 'Values must be unique').optional(),
  isPrimary: z.boolean().optional(),
});

const partyAddress = z.strictObject({
  kind: z.enum(ADDRESS_KINDS),
  line1: text(200),
  line2: text(200).optional(),
  cityId: objectId.optional(),
  postalCode: text(20).optional(),
  isDefault: z.boolean().optional(),
});

const bankAccount = z.strictObject({
  bankName: text(120),
  accountName: text(120),
  accountNumber: z.string().trim().regex(/^[A-Za-z0-9 -]{4,40}$/, '4-40 letters, digits, spaces or dashes'),
  branchCode: text(20).optional(),
  swift: z.string().trim().toUpperCase().regex(/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/, '8 or 11 character SWIFT/BIC').optional(),
  currencyId: objectId.optional(),
});

export const partyShape = {
  code: code.optional(),
  name,
  description: text(500).optional(),
  tradingName: text(120).optional(),
  roles: z.array(z.enum(PARTY_ROLES)).min(1).max(PARTY_ROLES.length).refine(unique, 'Roles must be unique'),
  taxId: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{4,30}$/, '4-30 letters, digits or dashes').optional(),
  registrationNumber: text(60).optional(),
  countryId: objectId.optional(),
  currencyId: objectId.optional(),
  paymentTermsDays: integer(0, 365).optional(),
  creditLimit: money.optional(),
  contacts: z.array(contact).max(50).optional(),
  addresses: z.array(partyAddress).max(30).optional(),
  bankAccounts: z.array(bankAccount).max(10).optional(),
  ...baseShape,
};

export const orderSourceShape = { code, name, description: text(500).optional(), referenceRequired: z.boolean().optional(), ...baseShape };

export const createPartySchema = z.strictObject(partyShape);
export const updatePartySchema = toUpdateSchema(partyShape);
export const createOrderSourceSchema = z.strictObject(orderSourceShape);
export const updateOrderSourceSchema = toUpdateSchema(orderSourceShape);
