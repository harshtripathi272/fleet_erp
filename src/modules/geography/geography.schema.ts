import { z } from 'zod';
import {
  address, baseShape, code, idList, integer, location, money, name, nonNegative, objectId, phone, positive, regexText, text, toUpdateSchema,
} from '../../core/masters/zod.js';
import { DIMENSIONS } from './models/unit.model.js';
import { PLACE_TYPES } from './models/place.model.js';
import { STOP_KINDS } from './models/route.model.js';
import { isTimeZone } from '../../core/format/regional.js';

const timezone = z.string().refine(isTimeZone, 'Unknown IANA time zone');

export const countryShape = {
  code: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2, e.g. ZM'),
  name,
  description: text(500).optional(),
  iso3: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'ISO 3166-1 alpha-3, e.g. ZMB').optional(),
  dialCode: z.string().trim().regex(/^\+\d{1,4}$/, '+ and the country code, e.g. +1').optional(),
  currencyId: objectId.optional(),
  drivingSide: z.enum(['left', 'right']).optional(),
  timezones: z.array(timezone).max(20).optional(),
  idTypes: z.array(z.strictObject({ key: z.string().regex(/^[a-z][a-z0-9_]{0,29}$/), label: text(60), pattern: regexText.optional() })).max(20).optional(),
  ...baseShape,
};

export const provinceShape = { code, name, description: text(500).optional(), countryId: objectId, ...baseShape };

export const cityShape = { code, name, description: text(500).optional(), provinceId: objectId, location: location.optional(), ...baseShape };

export const placeShape = {
  code, name, description: text(500).optional(),
  type: z.enum(PLACE_TYPES),
  cityId: objectId.optional(),
  address: address.optional(),
  location: location.optional(),
  geofenceRadiusM: integer(25, 50000).optional(),
  openingHours: text(200).optional(),
  contactName: text(120).optional(),
  contactPhone: phone.optional(),
  ownerPartyId: objectId.optional(),
  ...baseShape,
};

export const borderPostShape = {
  code, name, description: text(500).optional(),
  countryAId: objectId,
  countryBId: objectId,
  placeId: objectId.optional(),
  oneStopBorder: z.boolean().optional(),
  workingHours: text(120).optional(),
  typicalWaitHours: z.number().min(0).max(240).optional(),
  fees: z.array(z.strictObject({ description: text(120), amount: money })).max(30).optional(),
  clearingAgentPartyIds: idList(30).optional(),
  ...baseShape,
};

const stop = z.strictObject({
  placeId: objectId,
  kind: z.enum(STOP_KINDS),
  legKm: z.number().min(0).max(5000),
  borderPostId: objectId.optional(),
  loaded: z.boolean().optional(),
});

export const routeShape = {
  code, name, description: text(500).optional(),
  stops: z.array(stop).min(2).max(40),
  standardDays: z.number().min(0).max(60).optional(),
  fuelBudgetL: nonNegative.optional(),
  cashBudget: money.optional(),
  ...baseShape,
};

export const unitShape = {
  code: z.string().trim().min(1).max(12).regex(/^[A-Za-z0-9°%/.³²-]+$/, 'Short unit code, e.g. KG, L, M3'),
  name, description: text(500).optional(),
  symbol: text(12).optional(),
  dimension: z.enum(DIMENSIONS),
  decimals: integer(0, 6).optional(),
  ...baseShape,
};

export const unitConversionShape = {
  fromUnitId: objectId,
  toUnitId: objectId,
  factor: positive,
  productId: objectId.optional(),
  ...baseShape,
};

export const createCountrySchema = z.strictObject(countryShape);
export const updateCountrySchema = toUpdateSchema(countryShape);
export const createProvinceSchema = z.strictObject(provinceShape);
export const updateProvinceSchema = toUpdateSchema(provinceShape);
export const createCitySchema = z.strictObject(cityShape);
export const updateCitySchema = toUpdateSchema(cityShape);
export const createPlaceSchema = z.strictObject(placeShape);
export const updatePlaceSchema = toUpdateSchema(placeShape);
export const createBorderPostSchema = z.strictObject(borderPostShape);
export const updateBorderPostSchema = toUpdateSchema(borderPostShape);
export const createRouteSchema = z.strictObject(routeShape);
export const updateRouteSchema = toUpdateSchema(routeShape);
export const createUnitSchema = z.strictObject(unitShape);
export const updateUnitSchema = toUpdateSchema(unitShape);
export const createUnitConversionSchema = z.strictObject(unitConversionShape);
export const updateUnitConversionSchema = toUpdateSchema(unitConversionShape);

export const nearQuerySchema = z.strictObject({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radiusKm: z.coerce.number().positive().max(2000).default(50),
  type: z.enum(PLACE_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const convertQuerySchema = z.strictObject({
  fromUnitId: objectId,
  toUnitId: objectId,
  value: z.coerce.number().finite().min(-1e12).max(1e12),
  productId: objectId.optional(),
});

export type NearQuery = z.infer<typeof nearQuerySchema>;
export type ConvertQuery = z.infer<typeof convertQuerySchema>;
