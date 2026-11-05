import { z } from 'zod';
import { email, objectId, phone, text } from '../../core/masters/zod.js';
import { ARRIVAL_DETECTION, POSITION_SOURCES, SETTLEMENT_PERIODS } from './company.model.js';

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
  brand: z.strictObject({
    productName: text(60).nullable().optional(),
    shortName: text(24).nullable().optional(),
    logoFileId: objectId.nullable().optional(),
    logoDarkFileId: objectId.nullable().optional(),
    iconFileId: objectId.nullable().optional(),
    logoPdfFileId: objectId.nullable().optional(),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'A colour such as #1d4d3f').nullable().optional(),
    emailSenderName: text(80).nullable().optional(),
    signature: text(160).nullable().optional(),
  }).optional(),
  watermark: z.strictObject({
    mode: z.enum(['off', 'text', 'logo']).optional(),
    text: text(40).nullable().optional(),
    opacity: z.number().min(0.03).max(0.5).optional(),
    angle: z.number().int().min(-90).max(90).optional(),
    tripSheet: z.boolean().optional(),
    statement: z.boolean().optional(),
    invoice: z.boolean().optional(),
    screens: z.boolean().optional(),
  }).optional(),
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
    positionSource: z.enum(POSITION_SOURCES).optional(),
    arrivalDetection: z.enum(ARRIVAL_DETECTION).optional(),
    arrivalDwellMinutes: z.number().min(0).max(120).optional(),
    trackerPollSeconds: z.number().int().min(15).max(3600).optional(),
  }).refine((o) => o.densityMinKgM3 === undefined || o.densityMaxKgM3 === undefined || o.densityMinKgM3 < o.densityMaxKgM3, 'Minimum density must be below the maximum').optional(),
};

/** First save creates the company; later saves must send the version they edited. */
export const saveCompanySchema = z.strictObject({ ...companyShape, version: z.number().int().min(0).optional() });
