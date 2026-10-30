import { z } from 'zod';
import { email, objectId, phone, text } from '../../core/masters/zod.js';

export const MODULES = ['masters', 'trips', 'finance', 'maintenance', 'tracking', 'billing'] as const;
const timezone = z.string().refine((tz) => Intl.supportedValuesOf('timeZone').includes(tz) || tz === 'UTC', 'Unknown time zone');

const companyShape = {
  legalName: text(200).optional(),
  tradingName: text(200).nullable().optional(),
  registrationNumber: text(60).nullable().optional(),
  taxId: text(60).nullable().optional(),
  countryId: objectId.nullable().optional(),
  baseCurrencyId: objectId.nullable().optional(),
  timezone: timezone.optional(),
  fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
  dateFormat: z.enum(['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD']).optional(),
  allowSelfRegistration: z.boolean().optional(),
  modules: z.array(z.enum(MODULES)).max(MODULES.length).refine((m) => new Set(m).size === m.length, 'Modules must be unique').optional(),
  address: z.strictObject({ line1: text(200), line2: text(200).optional(), city: text(100).optional(), postalCode: text(20).optional() }).nullable().optional(),
  phone: phone.nullable().optional(),
  email: email.nullable().optional(),
  website: z.url().max(300).nullable().optional(),
  logoUrl: z.url().max(2000).nullable().optional(),
};

/** First save creates the company; later saves must send the version they edited. */
export const saveCompanySchema = z.strictObject({ ...companyShape, version: z.number().int().min(0).optional() });
