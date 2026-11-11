import { z } from 'zod';
import type { PlaceHit } from '../../core/connections/index.js';
import { NOMINATIM_URL, nominatim } from '../../core/connections/providers/routing.js';
import { logger } from '../../core/logger/index.js';
import * as MasterService from '../../core/masters/service.js';
import type { Plain } from '../../core/masters/types.js';
import { ServiceUnavailableError } from '../../core/errors/index.js';
import { Company } from '../company/company.model.js';
import { recordError, recordUse, using } from '../connections/connections.service.js';
import { City } from './models/city.model.js';
import { Country } from './models/country.model.js';
import { Province } from './models/province.model.js';
import { cityDefinition, provinceDefinition } from './geography.service.js';

/**
 * Finding a place by its name or address instead of typing its latitude and longitude (#102). The search goes
 * through the company's map routing connection (Google, Mapbox, or OpenStreetMap's Nominatim for the others),
 * nearest the company's own country first. The city it's in is matched to the company's cities.
 */

export const findQuerySchema = z.strictObject({ q: z.string().trim().min(2).max(200), country: z.string().regex(/^[A-Z]{2}$/).optional(), anywhere: z.enum(['true', 'false']).optional() });
export type FindQuery = z.infer<typeof findQuerySchema>;

const code = (text: string) => text.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().toUpperCase().replace(/[\s_]+/g, '-').slice(0, 32) || 'PLACE';
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function companyCountry() {
  const company = await Company.findOne().select('countryId').lean<{ countryId?: unknown }>();
  return company?.countryId ? Country.findById(company.countryId).select('code').lean<{ _id: unknown; code: string }>() : null;
}

async function cityNamed(name: string | undefined, countryCode: string | undefined) {
  if (!name || !countryCode) return undefined;
  const country = await Country.findOne({ code: countryCode }).select('_id').lean<{ _id: unknown }>();
  if (!country) return undefined;
  const provinces = await Province.find({ countryId: country._id }).select('_id').lean<{ _id: unknown }[]>();
  const city = await City.findOne({ provinceId: { $in: provinces.map((p) => p._id) }, name: new RegExp(`^${escape(name)}$`, 'i'), status: 'active' }).select('_id').lean<{ _id: unknown }>();
  return city ? String(city._id) : undefined;
}

/** Places matching the words, each with the company's city it's in when there is one. */
export async function findPlaces(query: FindQuery) {
  const home = query.country ?? (query.anywhere === 'true' ? undefined : (await companyCountry())?.code);
  const service = await using('routing');
  let hits: PlaceHit[];
  try {
    hits = service.capability.search
      ? await service.capability.search(query.q, { countryCode: home })
      : await nominatim(NOMINATIM_URL, query.q, { countryCode: home });
    await recordUse(service.connection?._id);
  } catch (err) {
    await recordError(service.connection?._id, (err as Error).message);
    logger.warn({ err: (err as Error).message }, 'Place search failed');
    throw new ServiceUnavailableError(`The address search didn't answer (${(err as Error).message}). Try again, or put the pin on the map.`);
  }
  const results = [];
  for (const h of hits) results.push({ ...h, cityId: await cityNamed(h.city, h.countryCode) });
  return { searchedIn: home ?? null, via: service.provider.label, results };
}

export const cityForSchema = z.strictObject({
  city: z.string().trim().min(1).max(120), region: z.string().trim().min(1).max(120).optional(),
  countryCode: z.string().regex(/^[A-Z]{2}$/), lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional(),
});

/**
 * The company's city for a place picked from the search: found by name, or added with its region when the
 * country is one of the company's. Returns no city when the country isn't, rather than adding countries.
 */
export async function cityFor(input: z.infer<typeof cityForSchema>, ctx: { actorId?: string }) {
  const found = await cityNamed(input.city, input.countryCode);
  if (found) return { cityId: found, created: false };
  const country = await Country.findOne({ code: input.countryCode }).select('_id').lean<{ _id: unknown }>();
  if (!country) return { cityId: null, created: false, reason: `${input.countryCode} isn't one of the company's countries yet` };
  const regionName = input.region ?? input.city;
  let province = await Province.findOne({ countryId: country._id, name: new RegExp(`^${escape(regionName)}$`, 'i') }).select('_id').lean<{ _id: unknown }>();
  const context = { actorId: ctx.actorId, canSeeSensitive: true };
  if (!province) {
    const made = await MasterService.create(provinceDefinition, provinceDefinition.createSchema.parse({ code: await freeCode(Province, `${input.countryCode}-${code(regionName)}`), name: regionName, countryId: String(country._id) }) as Plain, context);
    province = { _id: made.id };
  }
  const city = await MasterService.create(cityDefinition, cityDefinition.createSchema.parse({
    code: await freeCode(City, `${input.countryCode}-${code(input.city)}`), name: input.city, provinceId: String(province._id),
    ...(input.lat !== undefined && input.lng !== undefined ? { location: { lat: input.lat, lng: input.lng } } : {}),
  }) as Plain, context);
  return { cityId: String(city.id), created: true };
}

async function freeCode(model: typeof City | typeof Province, base: string) {
  const stem = base.slice(0, 29);
  for (let i = 0; i < 50; i += 1) {
    const candidate = i ? `${stem}-${i + 1}` : base.slice(0, 32);
    if (!(await (model as typeof City).exists({ code: candidate }).collation({ locale: 'en', strength: 2 }))) return candidate;
  }
  return `${stem}-${Date.now() % 1000}`;
}
