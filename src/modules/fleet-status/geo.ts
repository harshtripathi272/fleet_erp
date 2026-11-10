import { haversineKm } from '../../core/connections/providers/routing.js';
import type { LatLng } from '../../core/connections/index.js';

/*
 * Geofences (#136): a place's circle (its radius around its location) or, when it has one, its polygon.
 * Pure functions, no library: the vendor reports enter and exit itself, so these are for our own checks.
 */

export { haversineKm };
export interface Geofenced { lat?: number; lng?: number; radiusM?: number; polygon?: LatLng[] }

/** Ray casting: true when the point is inside the ring (the ring need not repeat its first corner). */
export function insidePolygon(point: LatLng, ring: LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if ((a.lat > point.lat) !== (b.lat > point.lat) && point.lng < ((b.lng - a.lng) * (point.lat - a.lat)) / (b.lat - a.lat) + a.lng) inside = !inside;
  }
  return inside;
}

/** Inside the place's polygon when it has one (three corners or more), else inside its circle. */
export function insideGeofence(point: LatLng, place: Geofenced): boolean {
  if (place.polygon && place.polygon.length >= 3) return insidePolygon(point, place.polygon);
  if (place.lat === undefined || place.lng === undefined) return false;
  return haversineKm(point, { lat: place.lat, lng: place.lng }) * 1000 <= (place.radiusM ?? 300);
}

/** Compass bearing from a to b, 0–360 degrees. */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180;
  const y = Math.sin((b.lng - a.lng) * rad) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lng - a.lng) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

/** The smaller angle between two headings. */
export const headingGap = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
