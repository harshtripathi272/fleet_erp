import { z } from 'zod';
import { registerProvider } from '../registry.js';
import type { LatLng, PlaceHit, RouteAnswer } from '../types.js';
import { callJson } from './http.js';

/*
 * Map routing: road kilometres, driving hours and the line a map draws, for a list of stops. The routes
 * master's own distances still come first wherever a route gives them (see #60); this is for the rest.
 */

/** Great-circle distance in kilometres. */
export function haversineKm(a: LatLng, b: LatLng) {
  const r = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

const lngLat = (points: LatLng[]) => points.map((p) => `${p.lng},${p.lat}`).join(';');
const needTwo = (points: LatLng[]) => { if (points.length < 2) throw new Error('A route needs at least two points'); };
/** Two well-known towns, for "Test connection": Lusaka to Kapiri Mposhi. */
const TEST_POINTS: LatLng[] = [{ lat: -15.4167, lng: 28.2833 }, { lat: -13.9706, lng: 28.6693 }];
const tested = async (route: (p: LatLng[]) => Promise<RouteAnswer>) => {
  const answer = await route(TEST_POINTS);
  return { ok: answer.km > 0, message: `Lusaka to Kapiri Mposhi: ${Math.round(answer.km)} km${answer.hours ? `, ${answer.hours.toFixed(1)} h` : ''}.` };
};

/* ---------- Finding a place by name or address (#102) ---------- */

/** OpenStreetMap's own search, free and keyless; its rules ask for at most one search a second and a named app. */
export const NOMINATIM_URL = 'https://nominatim.openstreetmap.org';
const SEARCH_LABEL = 'Address search server';
const SEARCH_HINT = "Finds places by name or address on the place form. OpenStreetMap's Nominatim by default; your own copy of Nominatim can go here.";
const searchUrlField = z.url().refine((u) => /^https?:\/\//.test(u), 'An http or https address').default(NOMINATIM_URL);
const searchUrlOf = (settings: Record<string, unknown>) => String(settings.searchUrl || NOMINATIM_URL);
const SEARCH_LIMIT = 6;

let lastNominatim = 0;
/** One search a second across this server, as Nominatim's usage policy asks. */
async function nominatimTurn() {
  const wait = lastNominatim + 1100 - Date.now();
  lastNominatim = Math.max(Date.now(), lastNominatim + 1100);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

interface NominatimRow { lat: string; lon: string; name?: string; display_name: string; address?: Record<string, string> }
export async function nominatim(baseUrl: string, query: string, options: { countryCode?: string; signal?: AbortSignal } = {}): Promise<PlaceHit[]> {
  await nominatimTurn();
  const params = new URLSearchParams({ q: query, format: 'jsonv2', addressdetails: '1', limit: String(SEARCH_LIMIT) });
  if (options.countryCode) params.set('countrycodes', options.countryCode.toLowerCase());
  const rows = await callJson<NominatimRow[]>('Address search', `${baseUrl.replace(/\/$/, '')}/search?${params}`, {
    signal: options.signal, headers: { 'user-agent': 'fleet-erp (self-hosted transport software; place search)' },
  });
  return (rows ?? []).map((r) => {
    const a = r.address ?? {};
    return {
      name: r.name || r.display_name.split(',')[0]!.trim(), address: r.display_name, lat: Number(r.lat), lng: Number(r.lon),
      city: a.city ?? a.town ?? a.municipality ?? a.village ?? a.suburb, region: a.state ?? a.county ?? a.region,
      countryCode: a.country_code?.toUpperCase(),
    };
  });
}

async function mapboxSearch(token: string, query: string, options: { countryCode?: string; signal?: AbortSignal }): Promise<PlaceHit[]> {
  const params = new URLSearchParams({ q: query, limit: String(SEARCH_LIMIT), access_token: token });
  if (options.countryCode) params.set('country', options.countryCode.toLowerCase());
  const body = await callJson<{ features?: Array<{ properties: { name?: string; full_address?: string; coordinates: { latitude: number; longitude: number }; context?: Record<string, { name?: string; country_code?: string }> } }> }>('Mapbox', `https://api.mapbox.com/search/geocode/v6/forward?${params}`, { signal: options.signal });
  return (body.features ?? []).map(({ properties: p }) => ({
    name: p.name ?? p.full_address ?? '', address: p.full_address ?? p.name ?? '', lat: p.coordinates.latitude, lng: p.coordinates.longitude,
    city: p.context?.place?.name, region: p.context?.region?.name, countryCode: p.context?.country?.country_code?.toUpperCase(),
  }));
}

async function googleSearch(key: string, query: string, options: { countryCode?: string; signal?: AbortSignal }): Promise<PlaceHit[]> {
  const params = new URLSearchParams({ address: query, key });
  if (options.countryCode) params.set('components', `country:${options.countryCode}`);
  const body = await callJson<{ status?: string; error_message?: string; results?: Array<{ formatted_address: string; geometry: { location: { lat: number; lng: number } }; address_components: Array<{ long_name: string; short_name: string; types: string[] }> }> }>('Google Maps', `https://maps.googleapis.com/maps/api/geocode/json?${params}`, { signal: options.signal });
  if (body.status && !['OK', 'ZERO_RESULTS'].includes(body.status)) throw new Error(`Google Maps could not search (${body.status}${body.error_message ? `: ${body.error_message}` : ''})`);
  return (body.results ?? []).slice(0, SEARCH_LIMIT).map((r) => {
    const part = (type: string) => r.address_components.find((c) => c.types.includes(type));
    return {
      name: r.formatted_address.split(',')[0]!.trim(), address: r.formatted_address, lat: r.geometry.location.lat, lng: r.geometry.location.lng,
      city: part('locality')?.long_name ?? part('postal_town')?.long_name, region: part('administrative_area_level_1')?.long_name, countryCode: part('country')?.short_name,
    };
  });
}

/** Today's behaviour: a straight line between stops, times the company's road distance factor. */
registerProvider({
  kind: 'routing', key: 'straight-line', label: 'Straight line', simulated: true,
  description: "No map service: the straight line between stops, times a road factor. Maps draw straight lines. The routes master's distances still win.",
  fields: z.strictObject({ roadFactor: z.number().min(1).max(3).default(1.28), averageSpeedKmh: z.number().min(10).max(120).default(62), searchUrl: searchUrlField }),
  labels: { roadFactor: 'Road distance factor', averageSpeedKmh: 'Average speed (km/h)', searchUrl: SEARCH_LABEL },
  hints: { roadFactor: 'Road kilometres per straight-line kilometre; 1.28 suits most of Southern Africa', searchUrl: SEARCH_HINT },
  test: async (ctx) => tested(async (p) => straight(p, ctx.settings)),
  open: (ctx) => ({ route: async (points) => straight(points, ctx.settings), search: (q, o) => nominatim(searchUrlOf(ctx.settings), q, o) }),
});

function straight(points: LatLng[], settings: Record<string, unknown>): RouteAnswer {
  needTwo(points);
  let km = 0;
  for (let i = 1; i < points.length; i++) km += haversineKm(points[i - 1]!, points[i]!);
  km *= Number(settings.roadFactor ?? 1.28);
  return { km: Math.round(km), hours: Math.round((km / Number(settings.averageSpeedKmh ?? 62)) * 10) / 10, shape: points.map((p) => [p.lng, p.lat]) };
}

/** OSRM: open-source routing on OpenStreetMap, on your own server or a hosted one. */
registerProvider({
  kind: 'routing', key: 'osrm', label: 'OSRM',
  description: 'Open-source routing on OpenStreetMap roads, from a server you run or a hosted one.',
  fields: z.strictObject({ baseUrl: z.url().refine((u) => /^https?:\/\//.test(u), 'An http or https address'), searchUrl: searchUrlField }),
  labels: { baseUrl: 'Server address', searchUrl: SEARCH_LABEL },
  hints: { baseUrl: 'e.g. https://router.project-osrm.org (the public demo, for trying only)', searchUrl: SEARCH_HINT },
  test: async (ctx) => tested((p) => osrm(String(ctx.settings.baseUrl), p)),
  open: (ctx) => ({ route: (points, signal) => osrm(String(ctx.settings.baseUrl), points, signal), search: (q, o) => nominatim(searchUrlOf(ctx.settings), q, o) }),
});

async function osrm(baseUrl: string, points: LatLng[], signal?: AbortSignal): Promise<RouteAnswer> {
  needTwo(points);
  const body = await callJson<{ code?: string; routes?: Array<{ distance: number; duration: number; geometry: { coordinates: Array<[number, number]> } }> }>('OSRM',
    `${baseUrl.replace(/\/$/, '')}/route/v1/driving/${lngLat(points)}?overview=full&geometries=geojson`, { signal });
  const route = body.routes?.[0];
  if (!route) throw new Error(`OSRM found no road route (${body.code ?? 'no answer'})`);
  return { km: route.distance / 1000, hours: route.duration / 3600, shape: route.geometry.coordinates };
}

registerProvider({
  kind: 'routing', key: 'mapbox', label: 'Mapbox',
  description: 'Mapbox Directions for trucks on OpenStreetMap roads.',
  fields: z.strictObject({}),
  secrets: [{ key: 'accessToken', label: 'Access token', required: true }],
  test: async (ctx) => tested((p) => mapbox(ctx.secret('accessToken')!, p)),
  open: (ctx) => ({ route: (points, signal) => mapbox(ctx.secret('accessToken')!, points, signal), search: (q, o) => mapboxSearch(ctx.secret('accessToken')!, q, o) }),
});

async function mapbox(token: string, points: LatLng[], signal?: AbortSignal): Promise<RouteAnswer> {
  needTwo(points);
  const body = await callJson<{ routes?: Array<{ distance: number; duration: number; geometry: { coordinates: Array<[number, number]> } }>; message?: string }>('Mapbox',
    `https://api.mapbox.com/directions/v5/mapbox/driving/${lngLat(points)}?geometries=geojson&overview=full&access_token=${encodeURIComponent(token)}`, { signal });
  const route = body.routes?.[0];
  if (!route) throw new Error(`Mapbox found no road route${body.message ? `: ${body.message}` : ''}`);
  return { km: route.distance / 1000, hours: route.duration / 3600, shape: route.geometry.coordinates };
}

registerProvider({
  kind: 'routing', key: 'google', label: 'Google Maps',
  description: 'Google Directions. Needs a Maps Platform key with the Directions API switched on.',
  fields: z.strictObject({}),
  secrets: [{ key: 'apiKey', label: 'API key', required: true }],
  test: async (ctx) => tested((p) => google(ctx.secret('apiKey')!, p)),
  open: (ctx) => ({ route: (points, signal) => google(ctx.secret('apiKey')!, points, signal), search: (q, o) => googleSearch(ctx.secret('apiKey')!, q, o) }),
});

async function google(key: string, points: LatLng[], signal?: AbortSignal): Promise<RouteAnswer> {
  needTwo(points);
  const at = (p: LatLng) => `${p.lat},${p.lng}`;
  const via = points.slice(1, -1).map(at).join('|');
  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${at(points[0]!)}&destination=${at(points.at(-1)!)}${via ? `&waypoints=${encodeURIComponent(via)}` : ''}&key=${encodeURIComponent(key)}`;
  const body = await callJson<{ status?: string; error_message?: string; routes?: Array<{ legs: Array<{ distance: { value: number }; duration: { value: number } }>; overview_polyline: { points: string } }> }>('Google Maps', url, { signal });
  const route = body.routes?.[0];
  if (body.status !== 'OK' || !route) throw new Error(`Google Maps found no road route (${body.status ?? 'no answer'}${body.error_message ? `: ${body.error_message}` : ''})`);
  const metres = route.legs.reduce((sum, l) => sum + l.distance.value, 0);
  const seconds = route.legs.reduce((sum, l) => sum + l.duration.value, 0);
  return { km: metres / 1000, hours: seconds / 3600, shape: decodePolyline(route.overview_polyline.points) };
}

/** Google's encoded polyline, as [lng, lat] points. */
export function decodePolyline(encoded: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let index = 0, lat = 0, lng = 0;
  const next = () => {
    let result = 0, shift = 0, b: number;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && index <= encoded.length);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    lat += next();
    lng += next();
    out.push([lng / 1e5, lat / 1e5]);
  }
  return out;
}
