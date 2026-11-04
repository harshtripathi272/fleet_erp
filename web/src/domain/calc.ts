import type {
  AppData,
  Consignment,
  Measure,
  Place,
  Product,
  RouteStop,
  Stop,
  Trip,
  Truck,
} from "./types";

export const round = (value: number, digits = 2) => {
  const f = 10 ** digits;
  return Math.round((value + Number.EPSILON) * f) / f;
};

export function byId<T extends { id: string }>(list: T[], id?: string): T | undefined {
  return id ? list.find((item) => item.id === id) : undefined;
}

/* ---------- Geography ---------- */

function haversineKm(a: Place, b: Place) {
  const r = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

/** Each pair of places a route master gives the road kilometres for, both ways; the first route wins. */
const routeLegs = new WeakMap<AppData["routes"], Map<string, number>>();
function knownLegs(routes: AppData["routes"]) {
  let known = routeLegs.get(routes);
  if (!known) {
    known = new Map();
    for (const route of routes)
      for (let i = 1; i < route.stops.length; i++) {
        const a = route.stops[i - 1].placeId, b = route.stops[i].placeId, km = route.legKm[i] ?? 0;
        if (!known.has(`${a}-${b}`)) known.set(`${a}-${b}`, km);
        if (!known.has(`${b}-${a}`)) known.set(`${b}-${a}`, km);
      }
    routeLegs.set(routes, known);
  }
  return known;
}

/**
 * Road kilometres and driving hours between two places, by the same rules the API plans a trip with
 * (`buildStops` in src/modules/operations/trips.service.ts): the trip's own stops when there is a trip, then the
 * routes master, then straight line × the company's road distance factor. Hours are at the company's average speed.
 */
export function leg(data: AppData, fromId: string, toId: string, trip?: Pick<Trip, "stops">): { km: number; hours: number } {
  if (fromId === toId) return { km: 0, hours: 0 };
  const hours = (km: number) => round(km / (data.settings.averageSpeedKmh || 62), 1);
  const own = trip?.stops.findIndex((s, i) => i > 0 && trip.stops[i - 1].placeId === fromId && s.placeId === toId) ?? -1;
  if (own > 0) return { km: trip!.stops[own].legKm, hours: hours(trip!.stops[own].legKm) };
  const known = knownLegs(data.routes).get(`${fromId}-${toId}`);
  if (known !== undefined) return { km: known, hours: hours(known) };
  const a = byId(data.places, fromId);
  const b = byId(data.places, toId);
  if (!a || !b) return { km: 0, hours: 0 };
  const km = Math.round(haversineKm(a, b) * (data.settings.roadDistanceFactor || 1.28));
  return { km, hours: hours(km) };
}

/** The line drawn between two places on a map: straight for now (road-following shapes need a routing provider, #23). */
export function legShape(data: AppData, fromId: string, toId: string): [number, number][] {
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

/** Route stops that start where the truck is now. */
export function stopsFromTruck(route: RouteStop[], truck: Truck): RouteStop[] {
  if (!route.length) return route;
  if (route[0].placeId === truck.placeId) return route;
  return [{ placeId: truck.placeId, kind: "start" }, ...route.slice(1)];
}

/** Whether the leg arriving at stop `index` is driven loaded. */
export function legLoaded(stops: { kind: string }[], index: number) {
  const load = stops.findIndex((stop) => stop.kind === "load");
  const offload = stops.findIndex((stop) => stop.kind === "offload");
  return load >= 0 && index > load && (offload < 0 || index <= offload);
}

export function cumulativeKm(trip: Trip) {
  let total = 0;
  return trip.stops.map((stop) => (total += stop.legKm));
}

export function tripKm(trip: Trip) {
  return trip.stops.reduce((sum, stop) => sum + stop.legKm, 0);
}

export function tripHours(trip: Trip) {
  return round(trip.stops.reduce((sum, stop) => sum + stop.legHours, 0), 1);
}

export function loadedKm(trip: Trip) {
  return trip.stops.reduce((sum, stop, index) => sum + (legLoaded(trip.stops, index) ? stop.legKm : 0), 0);
}

/** Fuel the route needs, from each leg's distance and the truck's empty or loaded consumption, plus a 6% reserve. */
export function fuelEstimate(trip: Pick<Trip, "stops">, truck: Truck) {
  const litres = trip.stops.reduce((sum, stop, index) => {
    const kmpl = legLoaded(trip.stops, index) ? truck.loadedKmpl : truck.emptyKmpl;
    return sum + stop.legKm / kmpl;
  }, 0);
  return Math.ceil((litres * 1.06) / 5) * 5;
}

export function validateStops(stops: RouteStop[]) {
  if (stops.length < 2) return "Add the stops for this trip.";
  if (stops[0].kind !== "start") return "The first stop is the start.";
  if (stops.at(-1)?.kind !== "end") return "The last stop is the end.";
  const load = stops.findIndex((stop) => stop.kind === "load");
  const offload = stops.findIndex((stop) => stop.kind === "offload");
  if (load < 0) return "Add a loading point.";
  if (offload < 0) return "Add an offloading point.";
  if (offload < load) return "Offloading comes after loading.";
  if (stops.some((stop) => !stop.placeId)) return "Choose a place for every stop.";
  return null;
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

/* ---------- Fuel cargo ---------- */

/**
 * Volume correction factor to 20 °C for refined products (API MPMS 11.1 form, 20 °C base).
 * Density is the observed density in kg/m³ at the observed temperature.
 */
export function vcf20(observedDensity: number, tempC: number, group: Product["fuelGroup"] = "diesel") {
  const constants = (rho: number) => {
    if (group === "petrol" || rho < 770.5) return (r: number) => 346.4228 / (r * r) + 0.4388 / r;
    if (rho < 788) return (r: number) => -0.00336312 + 2680.3206 / (r * r);
    if (group === "jet" || rho < 839) return (r: number) => 594.5418 / (r * r);
    return (r: number) => 186.9696 / (r * r) + 0.4862 / r;
  };
  const dt = tempC - 20;
  let rho20 = observedDensity;
  let factor = 1;
  for (let i = 0; i < 6; i++) {
    const alpha = constants(rho20)(rho20);
    factor = Math.exp(-alpha * dt * (1 + 0.8 * alpha * dt));
    rho20 = observedDensity / factor;
  }
  return { vcf: round(factor, 5), density20: round(rho20, 1) };
}

export function measureFuel(product: Product, input: {
  qty?: number;
  ambientL?: number;
  tempC?: number;
  density?: number;
  certStd20L?: number;
}): Measure {
  const ambient = input.ambientL ?? input.qty ?? 0;
  if (product.kind !== "fuel" || input.tempC == null || input.density == null)
    return { qty: input.qty ?? ambient, unit: product.unit };
  const { vcf } = vcf20(input.density, input.tempC, product.fuelGroup);
  const std20 = round(ambient * vcf, 0);
  return {
    qty: ambient,
    unit: "L",
    ambientL: ambient,
    tempC: input.tempC,
    density: input.density,
    vcf,
    std20L: std20,
    certStd20L: input.certStd20L,
  };
}

export const volume20 = (measure?: Measure) => measure?.certStd20L ?? measure?.std20L;

export function shortageFor(data: AppData, consignment: Consignment) {
  const product = byId(data.products, consignment.productId);
  const loaded = volume20(consignment.load);
  const delivered = volume20(consignment.delivered);
  if (!product || product.kind !== "fuel" || loaded == null || delivered == null) return undefined;
  const lossL = Math.max(0, round(loaded - delivered, 0));
  const pct = product.shortagePct ?? 0.3;
  const allowanceL = round((loaded * pct) / 100, 0);
  const netShortL = Math.max(0, round(lossL - allowanceL, 0));
  // The product's shortage price; with none set, nothing is charged rather than a made-up rate.
  const pricePerL = product.shortagePricePerL ?? 0;
  return {
    loaded20L: loaded,
    delivered20L: delivered,
    lossL,
    allowancePct: pct,
    allowanceL,
    netShortL,
    pricePerL,
    amountZmw: round(netShortL * pricePerL, 0),
    status: netShortL > 0 ? ("pending" as const) : ("none" as const),
  };
}

/* ---------- Money ---------- */

/**
 * An amount in the base currency. `fx` is the rate the API used when it was paid; otherwise the latest rate in
 * the exchange-rates master. With no rate the result is NaN (shown as "—"): a figure is never guessed.
 */
export const toZmw = (data: AppData, amount: number, currency: string, fx?: number) =>
  currency === (data.baseCurrency?.code ?? "ZMW") ? amount : amount * (fx ?? data.settings.fx[currency] ?? Number.NaN);

export interface LedgerEntry {
  id: string;
  at: string;
  tripId?: string;
  settlementId?: string;
  kind: "opening" | "advance" | "expense" | "shortage" | "write_off" | "cash";
  label: string;
  amountZmw: number;
}

/**
 * Driver cash account. Positive balance: the driver holds company cash.
 * Negative: the company owes the driver.
 */
export function driverLedger(data: AppData, driverId: string): LedgerEntry[] {
  const driver = byId(data.drivers, driverId);
  const trips = new Map(data.trips.filter((t) => t.driverId === driverId).map((t) => [t.id, t]));
  const entries: LedgerEntry[] = [];
  if (driver?.openingBalanceZmw)
    entries.push({
      id: `open-${driverId}`,
      at: "2000-01-01T00:00:00.000Z",
      kind: "opening",
      label: "Carried in",
      amountZmw: driver.openingBalanceZmw,
      settlementId: "opening",
    });
  for (const request of data.requests) {
    const trip = trips.get(request.tripId);
    if (!trip || request.kind !== "cash" || request.status !== "issued") continue;
    entries.push({
      id: request.id,
      at: request.issuedAt!,
      tripId: trip.id,
      settlementId: trip.settlementId,
      kind: "advance",
      label: `Advance ${request.no}`,
      amountZmw: round(toZmw(data, request.amount, request.currency, request.fxAtIssue)),
    });
  }
  for (const expense of data.expenses) {
    if (expense.driverId !== driverId || expense.status !== "approved") continue;
    const trip = expense.tripId ? trips.get(expense.tripId) : undefined;
    entries.push({
      id: expense.id,
      at: expense.at,
      tripId: expense.tripId,
      settlementId: trip?.settlementId,
      kind: "expense",
      label: `${byId(data.categories, expense.categoryId)?.name ?? "Expense"} ${expense.receiptNo ?? ""}`.trim(),
      amountZmw: -expense.amountZmw,
    });
  }
  for (const item of data.consignments) {
    const trip = trips.get(item.tripId);
    if (!trip || item.shortage?.status !== "charged") continue;
    entries.push({
      id: `short-${item.id}`,
      at: item.shortage.decidedAt!,
      tripId: trip.id,
      settlementId: trip.settlementId,
      kind: "shortage",
      label: `Fuel shortage ${item.no} · ${item.shortage.netShortL.toLocaleString("en-GB")} L`,
      amountZmw: item.shortage.amountZmw,
    });
  }
  // A load written off and carried by the driver is recovered through their account (#64).
  for (const item of data.consignments) {
    const trip = trips.get(item.tripId);
    if (!trip || item.writeOff?.status !== "approved" || item.writeOff.carrier !== "driver") continue;
    entries.push({ id: `writeoff-${item.id}`, at: item.writeOff.decidedAt!, tripId: trip.id, settlementId: trip.settlementId, kind: "write_off", label: `Load written off ${item.no}`, amountZmw: item.writeOff.amountZmw });
  }
  for (const s of data.settlements) {
    if (s.driverId !== driverId || !s.cashZmw) continue;
    entries.push({
      id: `cash-${s.id}`,
      at: s.postedAt,
      settlementId: s.id,
      kind: "cash",
      label: s.cashZmw > 0 ? `Cash returned · ${s.no}` : `Paid to driver · ${s.no}`,
      amountZmw: -s.cashZmw,
    });
  }
  return entries.sort((a, b) => a.at.localeCompare(b.at));
}

export function driverBalance(data: AppData, driverId: string) {
  return round(driverLedger(data, driverId).reduce((sum, entry) => sum + entry.amountZmw, 0));
}

/** What the driver carries into a trip: everything on his account not produced by this trip. */
export function carriedIn(data: AppData, trip: Trip) {
  if (!trip.driverId) return 0;
  return round(
    driverLedger(data, trip.driverId)
      .filter((entry) => entry.tripId !== trip.id)
      .reduce((sum, entry) => sum + entry.amountZmw, 0),
  );
}

export function funding(data: AppData, trip: Trip) {
  const truck = byId(data.trucks, trip.truckId)!;
  const requests = data.requests.filter((item) => item.tripId === trip.id);
  const sum = (kind: "fuel" | "cash", statuses: string[]) =>
    round(
      requests
        .filter((item) => item.kind === kind && statuses.includes(item.status))
        .reduce((total, item) => total + toZmw(data, item.amount, item.currency, item.fxAtIssue), 0),
    );
  const fuelIssued = sum("fuel", ["issued"]);
  const fuelOpen = sum("fuel", ["pending", "owner", "approved"]);
  const fuelBaseline = trip.openingFuelL;
  // A truck with no tank size recorded has no limit, as on the server.
  const room = truck.tankL ? Math.max(0, truck.tankL - truck.fuelL - fuelOpen) : Infinity;
  // Never suggest more than the tank takes; a longer route is topped up on the way.
  const fuelSuggested = Math.min(room, Math.max(0, Math.ceil(trip.fuelBudgetL - fuelBaseline - fuelIssued - fuelOpen)));
  const holds = carriedIn(data, trip);
  const cashIssued = sum("cash", ["issued"]);
  const cashOpen = sum("cash", ["pending", "owner", "approved"]);
  const cashSuggested = Math.max(
    0,
    Math.round(trip.cashBudgetZmw - Math.max(0, holds) - cashIssued - cashOpen),
  );
  return {
    fuel: {
      budget: trip.fuelBudgetL,
      onTruck: fuelBaseline,
      open: fuelOpen,
      issued: fuelIssued,
      suggested: fuelSuggested,
      room,
    },
    cash: {
      budget: trip.cashBudgetZmw,
      holds,
      open: cashOpen,
      issued: cashIssued,
      suggested: cashSuggested,
    },
  };
}

/** Fuel left on the truck at a given point of the trip, from consumption since dispatch. */
export function fuelNow(data: AppData, trip: Trip) {
  const truck = byId(data.trucks, trip.truckId)!;
  if (!trip.dispatchedAt || trip.endedAt) return truck.fuelL;
  const km = trip.tracking?.km ?? 0;
  const cum = cumulativeKm(trip);
  let used = 0;
  for (let i = 1; i < trip.stops.length; i++) {
    const legStart = cum[i - 1];
    const covered = Math.max(0, Math.min(km, cum[i]) - legStart);
    used += covered / (legLoaded(trip.stops, i) ? truck.loadedKmpl : truck.emptyKmpl);
  }
  return Math.max(0, round(truck.fuelL - used, 0));
}

export function tripFuelUsed(data: AppData, trip: Trip) {
  if (trip.closingFuelL == null) return undefined;
  const issued = data.requests
    .filter((r) => r.tripId === trip.id && r.kind === "fuel" && r.status === "issued")
    .reduce((sum, r) => sum + r.amount, 0);
  return round(trip.openingFuelL + issued - trip.closingFuelL, 0);
}
