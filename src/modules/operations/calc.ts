/**
 * Pure trip arithmetic, ported from the trip-flow mock (`domain/calc.ts`) so both give the same figures:
 * road legs, fuel budget, 20 °C correction, shortage beyond the allowance.
 */

export const round = (value: number, digits = 2) => {
  const f = 10 ** digits;
  return Math.round((value + Number.EPSILON) * f) / f;
};

export interface LatLng { lat: number; lng: number }
export interface StopPlan { placeId: string; kind: string }
export interface StopLeg extends StopPlan { legKm: number; legHours: number }

/** Great-circle distance; road distance is estimated as 1.28 × this when no route gives it. */
export function haversineKm(a: LatLng, b: LatLng) {
  const r = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

/**
 * What any trip's stops must be: a start first and an end last, one of each, a place for every stop, and somewhere to
 * load (unless the company runs trips without cargo). Which stop each consignment loads and drops at is checked on
 * the consignment (#135); the old rule of exactly one loading and one offloading point is gone.
 */
export function validateStops(stops: StopPlan[], options: { tripsWithoutCargo?: boolean } = {}): string | null {
  if (stops.length < 2) return 'Add the stops for this trip.';
  if (stops[0]!.kind !== 'start') return 'The first stop is the start.';
  if (stops.at(-1)!.kind !== 'end') return 'The last stop is the end.';
  if (stops.filter((s) => s.kind === 'start' || s.kind === 'end').length !== 2) return 'A trip has one start and one end.';
  if (stops.some((s) => !s.placeId)) return 'Choose a place for every stop.';
  const load = stops.findIndex((s) => s.kind === 'load');
  if (load < 0 && !options.tripsWithoutCargo) return 'Add a loading point.';
  const offload = stops.findIndex((s) => s.kind === 'offload');
  if (offload >= 0 && load >= 0 && offload < load) return 'Offloading comes after loading.';
  return null;
}

/** Whether the leg arriving at stop `index` is driven loaded. */
export function legLoaded(stops: { kind: string }[], index: number) {
  const load = stops.findIndex((s) => s.kind === 'load');
  const offload = stops.map((s) => s.kind).lastIndexOf('offload');
  return load >= 0 && index > load && (offload < 0 || index <= offload);
}

export function cumulativeKm(stops: { legKm: number }[]) {
  let total = 0;
  return stops.map((s) => (total += s.legKm));
}

export const tripKm = (stops: { legKm: number }[]) => stops.reduce((sum, s) => sum + s.legKm, 0);

/** Fuel the stops need from each leg's distance and the truck's loaded or empty consumption, plus the reserve, rounded up to 5 L. */
export function fuelEstimate(stops: { kind: string; legKm: number }[], kmPerLLoaded: number, kmPerLEmpty: number, reservePercent = 6) {
  const litres = stops.reduce((sum, stop, index) => sum + stop.legKm / (legLoaded(stops, index) ? kmPerLLoaded : kmPerLEmpty), 0);
  return Math.ceil((litres * (1 + reservePercent / 100)) / 5) * 5;
}

/**
 * Volume correction factor to 20 °C for refined products (API MPMS 11.1 form, 20 °C base),
 * iterating on density. Density is observed kg/m³ at the observed temperature.
 */
export function vcf20(observedDensity: number, tempC: number) {
  const alphaOf = (rho: number) => {
    if (rho < 770.5) return 346.4228 / (rho * rho) + 0.4388 / rho;
    if (rho < 788) return -0.00336312 + 2680.3206 / (rho * rho);
    if (rho < 839) return 594.5418 / (rho * rho);
    return 186.9696 / (rho * rho) + 0.4862 / rho;
  };
  const dt = tempC - 20;
  let rho20 = observedDensity;
  let factor = 1;
  for (let i = 0; i < 6; i += 1) {
    const alpha = alphaOf(rho20);
    factor = Math.exp(-alpha * dt * (1 + 0.8 * alpha * dt));
    rho20 = observedDensity / factor;
  }
  return { vcf: round(factor, 5), density20: round(rho20, 1) };
}

export interface MeasureInput { qty: number; ambientL?: number; tempC?: number; density?: number; certStd20L?: number; gross?: number; tare?: number; ticketNo?: string }
export interface Measure { qty: number; unit: string; ambientL?: number; tempC?: number; density?: number; vcf?: number; std20L?: number; certStd20L?: number; gross?: number; tare?: number; ticketNo?: string }

/** A load or delivery as recorded. Volume-corrected products with temperature and density get their 20 °C volume. */
export function measure(product: { volumeCorrected?: boolean; unit: string }, input: MeasureInput): Measure {
  const ambient = input.ambientL ?? input.qty;
  if (!product.volumeCorrected || input.tempC == null || input.density == null) {
    // A weighbridge ticket's figures stay with the net they make.
    const ticket = input.gross != null ? { gross: input.gross, tare: input.tare, ticketNo: input.ticketNo } : {};
    return { qty: input.qty, unit: product.unit, ...ticket };
  }
  const { vcf } = vcf20(input.density, input.tempC);
  return {
    qty: ambient, unit: 'L', ambientL: ambient, tempC: input.tempC, density: input.density, vcf,
    std20L: round(ambient * vcf, 0), ...(input.certStd20L != null ? { certStd20L: input.certStd20L } : {}),
  };
}

/** The certificate's 20 °C volume when given, otherwise the computed one. */
export const volume20 = (m?: Partial<Measure>) => m?.certStd20L ?? m?.std20L;

/** Transit loss beyond the allowance, in the product's unit: for fuel, whole litres at 20 °C. */
export function shortageLitres(loaded20L: number, delivered20L: number, allowancePercent: number, decimals = 0) {
  const lossL = Math.max(0, round(loaded20L - delivered20L, decimals));
  const allowanceL = round((loaded20L * allowancePercent) / 100, decimals);
  return { loaded20L, delivered20L, lossL, allowancePercent, allowanceL, netShortL: Math.max(0, round(lossL - allowanceL, decimals)) };
}

/**
 * Times for stops passed without a report, spread by distance between the last stamped stop and
 * `index`, so the trip sheet reads like a real drive. Mutates the stops.
 */
export function stampArrival(stops: Array<{ legKm: number; arrivedAt?: Date; leftAt?: Date }>, index: number, at: Date) {
  const stop = stops[index]!;
  if (stop.arrivedAt) return false;
  stop.arrivedAt = at;
  const cum = cumulativeKm(stops);
  let last = 0;
  for (let i = 0; i < index; i += 1) if (stops[i]!.arrivedAt) last = i;
  const span = cum[index]! - cum[last]!;
  const lastStop = stops[last]!;
  lastStop.leftAt ??= span > 0.01 ? (lastStop.arrivedAt ?? at) : at;
  const t0 = lastStop.leftAt.getTime();
  const t1 = at.getTime();
  for (let i = 0; i < index; i += 1) {
    const s = stops[i]!;
    if (!s.arrivedAt) {
      const share = i > last && span > 0 ? (cum[i]! - cum[last]!) / span : 1;
      s.arrivedAt = new Date(Math.min(t1, t0 + (t1 - t0) * share));
    }
    s.leftAt ??= s.arrivedAt;
  }
  return true;
}
