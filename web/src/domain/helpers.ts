import { byId } from "./calc";
import { cash, L, inBase } from "../ui/format";
import type { AppData, Trip } from "./types";

/** Read-side helpers the desks share. The rules themselves run on the API. */

export const nowIso = (data: AppData) => new Date(Date.now() + data.settings.clockOffsetMs).toISOString();

// The same formatting as the screens: the company's base currency, and figures that never break across lines.
export { inBase };
export const litres = (value: number) => L(value);
export const money = cash;

export const activeTrip = (trip: Trip) => !trip.endedAt && !trip.cancelledAt;
/** Waiting for the driver's settlement: ended, or cancelled after cash was paid or spent on it. */
export const toSettle = (trip: Trip) => !trip.settlementId && Boolean(trip.endedAt || trip.settleAfterCancel);
/** When the trip stopped: ended, or cancelled. */
export const closedAt = (trip: Trip) => trip.endedAt ?? trip.cancelledAt;
export const placeName = (data: AppData, id?: string) => byId(data.places, id)?.name ?? "—";
export const firstName = (name?: string) => name?.split(" ")[0] ?? "";

/** First loading to last drop, naming the work stops between (#102): a trip going on to Kampala says so. */
export function routeLabel(data: AppData, trip: Pick<Trip, "stops">) {
  const work = trip.stops.filter((s) => s.kind === "load" || s.kind === "offload");
  const first = work.find((s) => s.kind === "load") ?? work[0];
  const last = [...work].reverse().find((s) => s.kind === "offload") ?? work.at(-1);
  const between = [...new Set(work.slice(work.indexOf(first!) + 1, last ? work.lastIndexOf(last) : undefined).map((s) => s.placeId))]
    .filter((p) => p !== first?.placeId && p !== last?.placeId);
  const via = between.length === 0 ? "" : between.length <= 2 ? ` via ${between.map((p) => placeName(data, p)).join(" and ")}` : ` via ${between.length} stops`;
  return `${placeName(data, first?.placeId)} to ${placeName(data, last?.placeId)}${via}`;
}
