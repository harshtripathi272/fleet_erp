import { byId } from "./calc";
import { cash, L, zmw as base } from "../ui/format";
import type { AppData, Trip } from "./types";

/** Read-side helpers the desks share. The rules themselves run on the API. */

export const nowIso = (data: AppData) => new Date(Date.now() + data.settings.clockOffsetMs).toISOString();

// The same formatting as the screens: the company's base currency, and figures that never break across lines.
export const zmw = (value: number) => base(value);
export const litres = (value: number) => L(value);
export const money = cash;

export const activeTrip = (trip: Trip) => !trip.endedAt && !trip.cancelledAt;
/** Waiting for the driver's settlement: ended, or cancelled after cash was paid or spent on it. */
export const toSettle = (trip: Trip) => !trip.settlementId && Boolean(trip.endedAt || trip.settleAfterCancel);
/** When the trip stopped: ended, or cancelled. */
export const closedAt = (trip: Trip) => trip.endedAt ?? trip.cancelledAt;
export const placeName = (data: AppData, id?: string) => byId(data.places, id)?.name ?? "—";
export const firstName = (name?: string) => name?.split(" ")[0] ?? "";

export function routeLabel(data: AppData, trip: Pick<Trip, "stops">) {
  const load = trip.stops.find((s) => s.kind === "load");
  const offload = trip.stops.find((s) => s.kind === "offload");
  return `${placeName(data, load?.placeId)} to ${placeName(data, offload?.placeId)}`;
}
