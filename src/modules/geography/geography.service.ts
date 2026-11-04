import { Types } from 'mongoose';
import { NotFoundError, ValidationError } from '../../core/errors/index.js';
import { defineMaster } from '../../core/masters/define.js';
import { GROUPS } from '../../core/masters/groups.js';
import { idQuery } from '../../core/masters/query.js';
import { serialize } from '../../core/masters/service.js';
import type { MasterDefinition, Plain } from '../../core/masters/types.js';
import { z } from 'zod';
import * as S from './geography.schema.js';
import { BorderPost } from './models/borderPost.model.js';
import { City } from './models/city.model.js';
import { Country } from './models/country.model.js';
import { PLACE_TYPES, Place } from './models/place.model.js';
import { Province } from './models/province.model.js';
import { Route } from './models/route.model.js';
import { DIMENSIONS, Unit } from './models/unit.model.js';
import { UnitConversion } from './models/unitConversion.model.js';

const byId = (field: string) => ({ schema: idQuery, apply: (v: string) => ({ [field]: new Types.ObjectId(v) }), description: `Only records with this ${field}` });

export const countryDefinition = defineMaster({
  key: 'countries', label: 'Countries', singular: 'Country', group: GROUPS.geography,
  description: 'Countries the company operates in or through, with dialling code, currency and the national ID types drivers carry.',
  model: Country, createSchema: S.createCountrySchema, updateSchema: S.updateCountrySchema,
  searchFields: ['code', 'name', 'iso3'],
  refs: [{ path: 'currencyId', target: 'currencies' }],
  async prepare(data: Plain) {
    const keys = ((data.idTypes ?? []) as Array<{ key: string }>).map((t) => t.key);
    if (new Set(keys).size !== keys.length) throw new ValidationError('ID type keys must be unique', { idTypes: ['Duplicate key'] });
    return data;
  },
});

export const provinceDefinition = defineMaster({
  key: 'provinces', label: 'Provinces', singular: 'Province', group: GROUPS.geography,
  description: 'Provinces or states inside a country. Codes are unique within their country.',
  model: Province, createSchema: S.createProvinceSchema, updateSchema: S.updateProvinceSchema,
  refs: [{ path: 'countryId', target: 'countries' }],
  filters: { countryId: byId('countryId') },
});

export const cityDefinition = defineMaster({
  key: 'cities', label: 'Cities', singular: 'City', group: GROUPS.geography,
  description: 'Towns and cities. The country is taken from the province.',
  model: City, createSchema: S.createCitySchema, updateSchema: S.updateCitySchema,
  refs: [{ path: 'provinceId', target: 'provinces' }],
  filters: { provinceId: byId('provinceId'), countryId: byId('countryId') },
  async prepare(data: Plain) {
    const province = await Province.findById(data.provinceId).select('countryId').lean();
    if (!province) throw new ValidationError('Province not found', { provinceId: ['Not found'] });
    return { ...data, countryId: province.countryId };
  },
});

export const placeDefinition = defineMaster({
  key: 'places', label: 'Places', singular: 'Place', group: GROUPS.geography, lockedChoices: ['kind'],
  description: 'Any point a truck starts, stops or ends at: depots, terminals, mines, ports, customer sites, borders.',
  model: Place, createSchema: S.createPlaceSchema, updateSchema: S.updatePlaceSchema,
  refs: [{ path: 'cityId', target: 'cities' }, { path: 'address.cityId', target: 'cities' }, { path: 'ownerPartyId', target: 'parties' }],
  filters: {
    type: { schema: z.enum(PLACE_TYPES), apply: (v: string) => ({ type: v }), description: 'Place type' },
    cityId: byId('cityId'),
  },
  async prepare(data: Plain) {
    const loc = data.location as { lat: number; lng: number } | undefined;
    return { ...data, geo: loc ? { type: 'Point', coordinates: [loc.lng, loc.lat] } : undefined };
  },
});

export const borderPostDefinition = defineMaster({
  key: 'border-posts', label: 'Border posts', singular: 'Border post', group: GROUPS.geography,
  description: 'Border crossings with both countries, typical waiting time, fees and approved clearing agents.',
  model: BorderPost, createSchema: S.createBorderPostSchema, updateSchema: S.updateBorderPostSchema,
  refs: [
    { path: 'countryAId', target: 'countries' }, { path: 'countryBId', target: 'countries' }, { path: 'placeId', target: 'places' },
    { path: 'fees.amount.currencyId', target: 'currencies' },
    { path: 'clearingAgentPartyIds', target: 'parties', partyRoles: ['clearing_agent'] },
  ],
  filters: { countryId: { schema: idQuery, apply: (v: string) => ({ $or: [{ countryAId: new Types.ObjectId(v) }, { countryBId: new Types.ObjectId(v) }] }), description: 'Border posts touching this country' } },
  async prepare(data: Plain) {
    if (String(data.countryAId) === String(data.countryBId)) throw new ValidationError('A border joins two different countries', { countryBId: ['Same as countryAId'] });
    return data;
  },
});

interface Stop { placeId: unknown; kind: string; legKm: number; borderPostId?: unknown; loaded?: boolean; }

/** Route rules: start → … → end, a load before the first offload, border stops name their border post. */
export function checkStops(stops: Stop[]) {
  const errors: string[] = [];
  if (stops.length < 2) errors.push('A route needs at least a start and an end');
  if (stops[0]?.kind !== 'start') errors.push('The first stop must be the start');
  if (stops.at(-1)?.kind !== 'end') errors.push('The last stop must be the end');
  if (stops[0] && stops[0].legKm !== 0) errors.push('The start stop has 0 km');
  stops.forEach((s, i) => {
    if (i > 0 && s.kind === 'start') errors.push(`Stop ${i + 1}: only the first stop can be the start`);
    if (i < stops.length - 1 && s.kind === 'end') errors.push(`Stop ${i + 1}: only the last stop can be the end`);
    if (s.kind === 'border' && !s.borderPostId) errors.push(`Stop ${i + 1}: border stops need a border post`);
    if (s.kind !== 'border' && s.borderPostId) errors.push(`Stop ${i + 1}: only border stops take a border post`);
    if (i > 0 && String(s.placeId) === String(stops[i - 1]!.placeId) && s.legKm > 0) errors.push(`Stop ${i + 1}: same place as the previous stop but ${s.legKm} km apart`);
  });
  const firstLoad = stops.findIndex((s) => s.kind === 'load');
  const firstOffload = stops.findIndex((s) => s.kind === 'offload');
  if (firstLoad < 0) errors.push('Add a loading stop');
  if (firstOffload < 0) errors.push('Add an offloading stop');
  if (firstLoad >= 0 && firstOffload >= 0 && firstOffload < firstLoad) errors.push('Offloading comes after loading');
  if (errors.length) throw new ValidationError('Route stops are not valid', { stops: errors });
}

/** Loaded legs are those between a load stop and the next offload unless marked explicitly. */
export function routeDistances(stops: Stop[]) {
  let carrying = false;
  let totalKm = 0;
  let loadedKm = 0;
  const marked = stops.map((s) => {
    const loaded = s.loaded ?? carrying;
    totalKm += s.legKm;
    if (loaded) loadedKm += s.legKm;
    if (s.kind === 'load') carrying = true;
    if (s.kind === 'offload') carrying = false;
    return { ...s, loaded };
  });
  return { stops: marked, totalKm: Math.round(totalKm * 10) / 10, loadedKm: Math.round(loadedKm * 10) / 10, emptyKm: Math.round((totalKm - loadedKm) * 10) / 10 };
}

export const routeDefinition = defineMaster({
  key: 'routes', label: 'Routes', singular: 'Route', group: GROUPS.geography,
  description: 'A standard journey: ordered stops with leg distances. Total, loaded and empty kilometres are calculated.',
  model: Route, createSchema: S.createRouteSchema, updateSchema: S.updateRouteSchema,
  sortFields: ['code', 'name', 'totalKm', 'createdAt', 'updatedAt'],
  refs: [{ path: 'stops.placeId', target: 'places' }, { path: 'stops.borderPostId', target: 'border-posts' }, { path: 'cashBudget.currencyId', target: 'currencies' }],
  filters: { placeId: { schema: idQuery, apply: (v: string) => ({ 'stops.placeId': new Types.ObjectId(v) }), description: 'Routes passing through this place' } },
  async prepare(data: Plain) {
    const stops = data.stops as Stop[];
    checkStops(stops);
    // Leg 1 starts at the start; `loaded` on the first stop is meaningless.
    const { stops: marked, ...km } = routeDistances(stops);
    marked[0]!.loaded = false;
    return { ...data, stops: marked, ...km };
  },
});

export const unitDefinition = defineMaster({
  key: 'units', label: 'Units of measure', singular: 'Unit', group: GROUPS.geography,
  description: 'kg, t, L, m³, pallet, bag, km, hour. Each unit has a dimension; conversions stay within it unless a product supplies density.',
  model: Unit, createSchema: S.createUnitSchema, updateSchema: S.updateUnitSchema,
  immutable: ['dimension'],
  filters: { dimension: { schema: z.enum(DIMENSIONS), apply: (v: string) => ({ dimension: v }), description: 'Unit dimension' } },
});

export const unitConversionDefinition = defineMaster({
  key: 'unit-conversions', label: 'Unit conversions', singular: 'Unit conversion', group: GROUPS.geography,
  description: 'Factor from one unit to another (1 from = factor × to). Converting between dimensions, e.g. L to kg, needs a product.',
  model: UnitConversion, createSchema: S.createUnitConversionSchema, updateSchema: S.updateUnitConversionSchema,
  searchFields: ['notes'], sortFields: ['createdAt', 'updatedAt', 'factor'], defaultSort: '-createdAt', titleField: 'factor',
  refs: [{ path: 'fromUnitId', target: 'units' }, { path: 'toUnitId', target: 'units' }, { path: 'productId', target: 'products' }],
  filters: { unitId: { schema: idQuery, apply: (v: string) => ({ $or: [{ fromUnitId: new Types.ObjectId(v) }, { toUnitId: new Types.ObjectId(v) }] }), description: 'Conversions involving this unit' } },
  async prepare(data: Plain) {
    if (String(data.fromUnitId) === String(data.toUnitId)) throw new ValidationError('Convert between two different units', { toUnitId: ['Same as fromUnitId'] });
    const units = await Unit.find({ _id: { $in: [data.fromUnitId, data.toUnitId] } }).select('dimension').lean();
    const dims = new Set(units.map((u) => u.dimension));
    if (dims.size > 1 && !data.productId) throw new ValidationError('Converting between dimensions needs a product (for density)', { productId: ['Required for cross-dimension conversions'] });
    return data;
  },
});

/* ---------- Custom operations ---------- */

export async function placesNear(query: S.NearQuery) {
  const filter: Plain = {
    status: 'active',
    geo: { $nearSphere: { $geometry: { type: 'Point', coordinates: [query.lng, query.lat] }, $maxDistance: query.radiusKm * 1000 } },
  };
  if (query.type) filter.type = query.type;
  const rows = await Place.find(filter).limit(query.limit).lean();
  const toRad = (d: number) => (d * Math.PI) / 180;
  return rows.map((row) => {
    const loc = row.location as { lat: number; lng: number };
    const dLat = toRad(loc.lat - query.lat);
    const dLng = toRad(loc.lng - query.lng);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(query.lat)) * Math.cos(toRad(loc.lat)) * Math.sin(dLng / 2) ** 2;
    const distanceKm = Math.round(6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 100) / 100;
    return { ...serialize(placeDefinition, row as Plain), distanceKm };
  });
}

export async function convertUnits(query: S.ConvertQuery) {
  const units = await Unit.find({ _id: { $in: [query.fromUnitId, query.toUnitId] } }).lean();
  if (units.length !== new Set([query.fromUnitId, query.toUnitId]).size) throw new NotFoundError('Unit not found');
  if (query.fromUnitId === query.toUnitId) return { value: query.value, result: query.value, factor: 1, method: 'identity' };
  const product = query.productId ? new Types.ObjectId(query.productId) : null;
  const find = (from: string, to: string) => UnitConversion.findOne({ fromUnitId: from, toUnitId: to, status: 'active', productId: product ?? { $exists: false } }).lean();
  const direct = await find(query.fromUnitId, query.toUnitId);
  if (direct) {
    const factor = Number(direct.factor);
    return { value: query.value, result: query.value * factor, factor, method: 'direct', conversionId: String(direct._id) };
  }
  const inverse = await find(query.toUnitId, query.fromUnitId);
  if (inverse) {
    const factor = 1 / Number(inverse.factor);
    return { value: query.value, result: query.value * factor, factor, method: 'inverse', conversionId: String(inverse._id) };
  }
  throw new NotFoundError('No active conversion between these units', { hint: 'Create a unit conversion for this pair' });
}

export const masters: MasterDefinition[] = [countryDefinition, provinceDefinition, cityDefinition, placeDefinition, borderPostDefinition, routeDefinition, unitDefinition, unitConversionDefinition];
