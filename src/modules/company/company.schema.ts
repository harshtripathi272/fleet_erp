import { z } from 'zod';
import { email, objectId, phone, text } from '../../core/masters/zod.js';
import { SETTLEMENT_PERIODS } from './company.model.js';
import { DATE_FORMATS, DECIMAL_SEPARATORS, THOUSANDS_SEPARATORS, TIME_FORMATS, UNIT_SYSTEMS, WEEK_STARTS } from '../../core/format/regional.js';

import { AREA_KEYS } from './areaList.js';

export const MODULES = AREA_KEYS;
const timezone = z.string().refine((tz) => Intl.supportedValuesOf('timeZone').includes(tz) || tz === 'UTC', 'Unknown time zone');

const companyShape = {
  legalName: text(200).optional(),
  tradingName: text(200).nullable().optional(),
  registrationNumber: text(60).nullable().optional(),
  taxId: text(60).nullable().optional(),
  countryId: objectId.nullable().optional(),
  baseCurrencyId: objectId.nullable().optional(),
  timezone: timezone.nullable().optional(),
  fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
  dateFormat: z.enum(DATE_FORMATS).optional(),
  /** Only the settings sent change; null puts one back to the country's or the default. */
  regional: z.strictObject({
    timeFormat: z.enum(TIME_FORMATS).nullable().optional(),
    decimalSeparator: z.enum(DECIMAL_SEPARATORS).nullable().optional(),
    thousandsSeparator: z.enum(THOUSANDS_SEPARATORS).nullable().optional(),
    firstDayOfWeek: z.enum(WEEK_STARTS).nullable().optional(),
    phoneCountryCode: z.string().trim().regex(/^\+\d{1,4}$/, 'A country code such as +255').nullable().optional(),
    unitSystem: z.enum(UNIT_SYSTEMS).nullable().optional(),
  }).refine((r) => !r.decimalSeparator || r.decimalSeparator !== r.thousandsSeparator, 'The decimal and thousands separators must differ').optional(),
  allowSelfRegistration: z.boolean().optional(),
  modules: z.array(z.enum(MODULES)).max(MODULES.length).refine((m) => new Set(m).size === m.length, 'Modules must be unique').optional(),
  address: z.strictObject({ line1: text(200), line2: text(200).optional(), city: text(100).optional(), postalCode: text(20).optional() }).nullable().optional(),
  phone: phone.nullable().optional(),
  email: email.nullable().optional(),
  website: z.url().max(300).nullable().optional(),
  logoUrl: z.url().max(2000).nullable().optional(),
  /** Only the settings sent change; the rest keep their values. */
  operations: z.strictObject({
    tripStartsFromTruck: z.boolean().optional(),
    roadDistanceFactor: z.number().min(1).max(3).optional(),
    averageSpeedKmh: z.number().min(10).max(120).optional(),
    deliveredOverLoadedPercent: z.number().min(0).max(20).optional(),
    densityMinKgM3: z.number().min(0).max(2000).optional(),
    densityMaxKgM3: z.number().min(0).max(2000).optional(),
    defaultShortageAllowancePercent: z.number().min(0).max(10).optional(),
    defaultFuelReservePercent: z.number().min(0).max(50).optional(),
    settlementPeriod: z.enum(SETTLEMENT_PERIODS).optional(),
    stopBeforeLoading: z.boolean().optional(),
  }).refine((o) => o.densityMinKgM3 === undefined || o.densityMaxKgM3 === undefined || o.densityMinKgM3 < o.densityMaxKgM3, 'Minimum density must be below the maximum').optional(),
};

/** First save creates the company; later saves must send the version they edited. */
export const saveCompanySchema = z.strictObject({ ...companyShape, version: z.number().int().min(0).optional() });
