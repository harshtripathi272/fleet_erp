import { workspaceInput } from './workspace.js';
import { z } from 'zod';
import { email, objectId, phone, text } from '../../core/masters/zod.js';
import { SETTLEMENT_PERIODS } from './company.model.js';
import { DATE_FORMATS, DECIMAL_SEPARATORS, THOUSANDS_SEPARATORS, TIME_FORMATS, UNIT_SYSTEMS, WEEK_STARTS } from '../../core/format/regional.js';

import { AREA_KEYS } from './areaList.js';
import { CARGO_KINDS, LOADED_TRIP_OUTCOMES, WRITE_OFF_CARRIERS } from './company.model.js';
import * as F from './company.model.js';
import { isTimeZone } from '../../core/format/regional.js';

export const MODULES = AREA_KEYS;
const timezone = z.string().refine(isTimeZone, 'Unknown time zone');

const companyShape = {
  ...workspaceInput,
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
  maintenance: z.strictObject({
    workOrderStopsTruck: z.boolean().optional(),
    defectStopsTruck: z.boolean().optional(),
    dueSoonKm: z.number().min(0).max(100_000).optional(),
    dueSoonDays: z.number().min(0).max(365).optional(),
    dueSoonHours: z.number().min(0).max(10_000).optional(),
  }).optional(),
  /** Company → Freight (#135): only the settings sent change; null puts one back to its default. */
  freight: z.strictObject({
    consignmentBy: z.enum(F.CONSIGNMENT_BY).nullable().optional(),
    maxConsignmentsPerTrip: z.number().int().min(0).max(1000).nullable().optional(),
    defaultConsignmentTypeId: objectId.nullable().optional(),
    consignorDefault: z.enum(F.CONSIGNOR_DEFAULTS).nullable().optional(),
    consigneeMustBeParty: z.boolean().nullable().optional(),
    consigneePhoneRequired: z.boolean().nullable().optional(),
    createPlacesFromAddresses: z.boolean().nullable().optional(),
    duplicateCheck: z.enum(F.DUPLICATE_CHECKS).nullable().optional(),
    bookWithoutTrip: z.boolean().nullable().optional(),
    stopsEditableOnRoad: z.boolean().nullable().optional(),
    lateSplit: z.enum(F.LATE_SPLIT).nullable().optional(),
    leaveStopRequires: z.array(z.enum(F.LEAVE_STOP_REQUIRES)).max(2).refine((v) => new Set(v).size === v.length, 'Each once').nullable().optional(),
    capacityCheck: z.enum(F.CAPACITY_CHECKS).nullable().optional(),
    capacityTolerancePercent: z.number().min(0).max(50).nullable().optional(),
    tripsWithoutCargo: z.boolean().nullable().optional(),
    podPerStopAllowed: z.boolean().nullable().optional(),
    notifyConsignee: z.boolean().nullable().optional(),
    ewayBillWarnHours: z.number().min(0).max(720).nullable().optional(),
    consignmentRateRequired: z.enum(F.RATE_REQUIRED).nullable().optional(),
    chargeOnDefault: z.enum(F.FREIGHT_CHARGE_ON).nullable().optional(),
    priceOnDefault: z.enum(F.FREIGHT_PRICE_ON).nullable().optional(),
    distanceSourceDefault: z.enum(F.FREIGHT_DISTANCE).nullable().optional(),
    shortageDeductionDefault: z.enum(F.FREIGHT_SHORTAGE).nullable().optional(),
    shortageScopeDefault: z.enum(F.SHORTAGE_SCOPES).nullable().optional(),
    detentionShare: z.enum(F.DETENTION_SHARES).nullable().optional(),
    costShareBy: z.enum(F.COST_SHARES).nullable().optional(),
    manualPriceNeedsReason: z.boolean().nullable().optional(),
    freezeOn: z.enum(F.FREEZE_ON).nullable().optional(),
    invoiceWithoutPod: z.boolean().nullable().optional(),
    profitCosts: z.array(z.enum(F.PROFIT_COSTS)).max(7).refine((v) => new Set(v).size === v.length, 'Each once').nullable().optional(),
    defaultFuelPricePerLMinor: z.number().int().min(0).max(1e9).nullable().optional(),
    overheadPerKmMinor: z.number().int().min(0).max(1e9).nullable().optional(),
    overheadPerDayMinor: z.number().int().min(0).max(1e11).nullable().optional(),
    transferRevenueSplit: z.enum(F.TRANSFER_SPLITS).nullable().optional(),
    showProfitOnTripList: z.boolean().nullable().optional(),
  }).optional(),
  /** Only the settings sent change; the rest keep their values. */
  operations: z.strictObject({
    cargoKinds: z.array(z.enum(CARGO_KINDS)).min(1, 'Keep at least one kind of cargo').max(3).optional(),
    loadedTripOutcomes: z.array(z.enum(LOADED_TRIP_OUTCOMES)).max(3).optional(),
    writeOffCarriers: z.array(z.enum(WRITE_OFF_CARRIERS)).max(3).optional(),
    writeOffDefaultCarrier: z.enum(WRITE_OFF_CARRIERS).optional(),
    loadedTripRoles: z.array(z.string().trim().regex(/^[a-z][a-z0-9_-]{0,39}$/, 'A role key')).max(30).optional(),
    writeOffNeedsOwner: z.boolean().optional(),
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
  })
    .refine((o) => !o.writeOffDefaultCarrier || !o.writeOffCarriers || o.writeOffCarriers.includes(o.writeOffDefaultCarrier), 'The default must be one of those allowed to carry a write-off')
    .refine((o) => o.densityMinKgM3 === undefined || o.densityMaxKgM3 === undefined || o.densityMinKgM3 < o.densityMaxKgM3, 'Minimum density must be below the maximum').optional(),
};

/** First save creates the company; later saves must send the version they edited. */
export const saveCompanySchema = z.strictObject({ ...companyShape, version: z.number().int().min(0).optional() });
