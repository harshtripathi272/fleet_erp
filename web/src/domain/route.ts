// Road distances, road shapes and a truck's position along its route. Apart from the rest of calc.ts
// because of the road data (about 130 kB), which only the office's route and map views need: the driver
// app and the sign-in screen never download it.
import { ROAD_KM_HOURS, ROAD_SHAPES } from "./geo-data";
import { byId, cumulativeKm, round } from "./calc";
import type { AppData, Place, RouteStop, Stop, Trip } from "./types";

function haversineKm(a: Place, b: Place) {
  const r = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

/** Road kilometres and driving hours between two places. */
export function leg(data: AppData, fromId: string, toId: string): { km: number; hours: number } {
  if (fromId === toId) return { km: 0, hours: 0 };
  const known = ROAD_KM_HOURS[`${fromId}-${toId}`];
  if (known) return { km: known[0], hours: known[1] };
  const a = byId(data.places, fromId);
  const b = byId(data.places, toId);
  if (!a || !b) return { km: 0, hours: 0 };
  const km = Math.round(haversineKm(a, b) * (data.settings.roadDistanceFactor || 1.28));
  return { km, hours: round(km / (data.settings.averageSpeedKmh || 62), 1) };
}

/** Road geometry between two places as [lng, lat] points. */
export function legShape(data: AppData, fromId: string, toId: string): [number, number][] {
  const known = ROAD_SHAPES[`${fromId}-${toId}`];
  if (known) return known;
  const reverse = ROAD_SHAPES[`${toId}-${fromId}`];
  if (reverse) return [...reverse].reverse();
  const a = byId(data.places, fromId);
  const b = byId(data.places, toId);
  if (!a || !b) return [];
  return [
    [a.lng, a.lat],
    [b.lng, b.lat],
  ];
}

export function tripShape(data: AppData, trip: Trip) {
  const legs: [number, number][][] = [];
  for (let i = 1; i < trip.stops.length; i++)
    legs.push(legShape(data, trip.stops[i - 1].placeId, trip.stops[i].placeId));
  return legs;
}

export function buildStops(data: AppData, route: RouteStop[], ids: () => string): Stop[] {
  return route.map((stop, index) => {
    const prev = route[index - 1];
    const l = prev ? leg(data, prev.placeId, stop.placeId) : { km: 0, hours: 0 };
    const place = byId(data.places, stop.placeId);
    return {
      id: ids(),
      placeId: stop.placeId,
      kind: stop.kind,
      legKm: l.km,
      legHours: round(l.hours + (place?.kind === "border" ? place.haltHours : 0), 1),
    };
  });
}

/* ---------- Position along a trip ---------- */

export function positionAt(data: AppData, trip: Trip, km: number) {
  const legs = tripShape(data, trip);
  const cum = cumulativeKm(trip);
  let index = cum.findIndex((value) => value >= km);
  if (index < 0) index = trip.stops.length - 1;
  if (index === 0) {
    const place = byId(data.places, trip.stops[0].placeId)!;
    return { lng: place.lng, lat: place.lat, heading: 0, legIndex: 0 };
  }
  const shape = legs[index - 1];
  const legStart = cum[index - 1];
  const legLength = trip.stops[index].legKm || 1;
  const t = Math.min(1, Math.max(0, (km - legStart) / legLength));
  return { ...alongShape(shape, t), legIndex: index };
}

function alongShape(shape: [number, number][], t: number) {
  if (shape.length < 2) {
    const p = shape[0] ?? [0, 0];
    return { lng: p[0], lat: p[1], heading: 0 };
  }
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < shape.length; i++) {
    const d = Math.hypot(shape[i][0] - shape[i - 1][0], shape[i][1] - shape[i - 1][1]);
    seg.push(d);
    total += d;
  }
  let target = t * total;
  for (let i = 0; i < seg.length; i++) {
    if (target <= seg[i] || i === seg.length - 1) {
      const f = seg[i] ? Math.min(1, target / seg[i]) : 0;
      const a = shape[i];
      const b = shape[i + 1];
      const heading = (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI;
      return { lng: a[0] + (b[0] - a[0]) * f, lat: a[1] + (b[1] - a[1]) * f, heading };
    }
    target -= seg[i];
  }
  const last = shape.at(-1)!;
  return { lng: last[0], lat: last[1], heading: 0 };
}
