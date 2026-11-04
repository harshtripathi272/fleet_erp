import { z } from 'zod';
import { registerProvider } from '../registry.js';
import type { LatLng, RouteAnswer } from '../types.js';
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

/** Today's behaviour: a straight line between stops, times the company's road distance factor. */
registerProvider({
  kind: 'routing', key: 'straight-line', label: 'Straight line', simulated: true,
  description: "No map service: the straight line between stops, times a road factor. Maps draw straight lines. The routes master's distances still win.",
  fields: z.strictObject({ roadFactor: z.number().min(1).max(3).default(1.28), averageSpeedKmh: z.number().min(10).max(120).default(62) }),
  labels: { roadFactor: 'Road distance factor', averageSpeedKmh: 'Average speed (km/h)' },
  hints: { roadFactor: 'Road kilometres per straight-line kilometre; 1.28 suits most of Southern Africa' },
  test: async (ctx) => tested(async (p) => straight(p, ctx.settings)),
  open: (ctx) => ({ route: async (points) => straight(points, ctx.settings) }),
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
  fields: z.strictObject({ baseUrl: z.url().refine((u) => /^https?:\/\//.test(u), 'An http or https address') }),
  labels: { baseUrl: 'Server address' },
  hints: { baseUrl: 'e.g. https://router.project-osrm.org (the public demo, for trying only)' },
  test: async (ctx) => tested((p) => osrm(String(ctx.settings.baseUrl), p)),
  open: (ctx) => ({ route: (points, signal) => osrm(String(ctx.settings.baseUrl), points, signal) }),
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
  open: (ctx) => ({ route: (points, signal) => mapbox(ctx.secret('accessToken')!, points, signal) }),
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
  open: (ctx) => ({ route: (points, signal) => google(ctx.secret('apiKey')!, points, signal) }),
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
