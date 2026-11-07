import * as Fmt from '../../../core/format/regional.js';
import { NotFoundError } from '../../../core/errors/index.js';
import type { Plain } from '../../../core/masters/types.js';
import { Product } from '../../cargo/models/product.model.js';
import { Consignment } from '../../operations/models/cargo.model.js';
import { refuse } from '../../operations/support.js';
import { routeLabel } from '../../operations/trips.service.js';
import { applyRate, rateBetween } from '../finance.service.js';
import { Currency } from '../models/currency.model.js';
import type { BillingSettings } from '../settings.service.js';
import { Party } from '../../parties/models/party.model.js';
import { CustomerRate } from './billing.model.js';

/**
 * Prices a closed trip for its customer (#61): the customer's rate for the trip's route and product on the
 * trip's date, charged on the delivered (or loaded) quantity, topped up to the minimum charge, less any
 * shortage beyond the allowance, with tax by Money settings. Amounts are in the invoice's currency.
 */

export interface PricedLine {
  kind: 'freight' | 'minimum' | 'shortage' | 'other';
  description: string;
  tripId?: unknown;
  consignmentId?: unknown;
  rateId?: unknown;
  qty: number;
  unit?: string;
  unitPriceMinor: number;
  taxPercent: number;
}

export interface Line extends PricedLine { amountMinor: number; taxMinor: number; netMinor: number }

const UNIT: Record<string, string> = { per_trip: 'trip', per_tonne: 't', per_litre_20: 'L at 20 °C', per_km: 'km' };
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** The rate between two currencies on a day, or a refusal saying which rate to add. */
export async function rateOrRefuse(fromId: string, toId: string, date: Date): Promise<number> {
  try {
    return (await rateBetween(fromId, toId, date)).rate;
  } catch (err) {
    if (err instanceof NotFoundError) throw refuse(`${err.message}. Add the rate under Exchange rates.`);
    throw err;
  }
}

export async function currencyUnits(id: unknown) {
  const c = await Currency.findById(id).select('code minorUnits').lean();
  if (!c) throw refuse('The currency was not found.');
  return { id: String(c._id), code: String(c.code), minorUnits: Number(c.minorUnits ?? 2) };
}

/** The customer's own invoice currency and payment terms, from its party record. */
export const termsOf = async (customerId: unknown) => Party.findById(customerId).select('currencyId paymentTermsDays').lean() as Promise<Plain | null>;

/** The day a trip is priced on: when it left, or was planned to. */
export const tripDay = (trip: Plain) => new Date((trip.dispatchedAt ?? trip.plannedStart) as string);

/** The most specific active rate for the trip on its day: its route and product beat a rate for any. */
export async function rateFor(trip: Plain): Promise<Plain> {
  const day = tripDay(trip);
  const candidates = await CustomerRate.find({
    customerId: trip.customerId, status: 'active',
    $and: [
      { $or: [{ validFrom: { $exists: false } }, { validFrom: null }, { validFrom: { $lte: day } }] },
      { $or: [{ validTo: { $exists: false } }, { validTo: null }, { validTo: { $gte: new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate())) } }] },
      { $or: [{ routeId: { $exists: false } }, { routeId: null }, ...(trip.routeId ? [{ routeId: trip.routeId }] : [])] },
      { $or: [{ productId: { $exists: false } }, { productId: null }, ...(trip.productId ? [{ productId: trip.productId }] : [])] },
    ],
  }).lean() as Plain[];
  const score = (r: Plain) => (r.routeId ? 2 : 0) + (r.productId ? 1 : 0);
  const best = candidates.sort((a, b) => score(b) - score(a) || +new Date((b.validFrom ?? 0) as string) - +new Date((a.validFrom ?? 0) as string))[0];
  if (!best) throw refuse(`No customer rate covers ${trip.number} on ${Fmt.date(day)}. Add one under Customer rates.`);
  return best;
}

/** Litres at 20 °C, tonnes, or km driven loaded, as the rate is charged. */
async function quantity(basis: string, measure: Plain | undefined, productId: unknown, label: string): Promise<number> {
  if (!measure) throw refuse(`${label} has no ${basis === 'per_trip' ? '' : 'measured '}quantity.`);
  const unit = String(measure.unit ?? '').toLowerCase();
  const litres = (measure.std20L ?? (/^(l|ltr|litres?)$/.test(unit) ? measure.qty : undefined)) as number | undefined;
  if (basis === 'per_litre_20') {
    if (litres === undefined) throw refuse(`${label} is measured in ${measure.unit}; a rate per litre at 20 °C needs litres.`);
    return round3(litres);
  }
  // per tonne
  if (/^(t|mt|tonnes?|tons?)$/.test(unit)) return round3(Number(measure.qty));
  if (unit === 'kg') return round3(Number(measure.qty) / 1000);
  const density = Number(measure.density ?? (await Product.findById(productId).select('densityKgPerL').lean())?.densityKgPerL ?? 0);
  // Density is kg/m³ on a measure (835), kg/L on a product (0.835).
  const kgPerL = density > 10 ? density / 1000 : density;
  const volume = (measure.std20L ?? measure.ambientL ?? litres) as number | undefined;
  if (!kgPerL || volume === undefined) throw refuse(`${label} has no weight or density, so it can't be charged per tonne.`);
  return round3((Number(volume) * kgPerL) / 1000);
}

/** km from the first loading to the last offloading. */
function loadedKm(trip: Plain): number {
  const stops = (trip.stops ?? []) as Array<{ kind: string; legKm: number }>;
  const first = stops.findIndex((s) => s.kind === 'load');
  const last = stops.map((s) => s.kind).lastIndexOf('offload');
  if (first < 0 || last <= first) return 0;
  return round3(stops.slice(first + 1, last + 1).reduce((km, s) => km + Number(s.legKm ?? 0), 0));
}

/** The tax on a line, by Money settings: none, the company's one rate, or the customer rate's own (per customer and product). */
export function taxPercentFor(settings: BillingSettings, rate: Plain | null): number {
  if (settings.taxMode === 'none') return 0;
  if (settings.taxMode === 'single') return settings.taxRatePercent;
  return Number(rate?.taxRatePercent ?? settings.taxRatePercent);
}

/** A line's amount, net and tax, with prices including or excluding tax. */
export function totalLine(line: PricedLine, pricesIncludeTax: boolean): Line {
  const amountMinor = Math.round(line.qty * line.unitPriceMinor);
  const p = line.taxPercent;
  const taxMinor = !p ? 0 : pricesIncludeTax ? Math.round((amountMinor * p) / (100 + p)) : Math.round((amountMinor * p) / 100);
  return { ...line, amountMinor, taxMinor, netMinor: pricesIncludeTax ? amountMinor - taxMinor : amountMinor };
}

export function totals(lines: Line[], pricesIncludeTax: boolean) {
  const netMinor = lines.reduce((s, l) => s + l.netMinor, 0);
  const taxMinor = lines.reduce((s, l) => s + l.taxMinor, 0);
  return { netMinor, taxMinor, totalMinor: pricesIncludeTax ? lines.reduce((s, l) => s + l.amountMinor, 0) : netMinor + taxMinor };
}

/** The invoice currency: the customer's own currency, else the rate's. */
export const invoiceCurrencyOf = (terms: Plain | null, rate: Plain) => String(terms?.currencyId ?? (rate.price as Plain).currencyId);

/** The lines for one closed trip, in `currencyId` on `date`. */
export async function priceTrip(trip: Plain, currencyId: string, date: Date, settings: BillingSettings): Promise<PricedLine[]> {
  const rate = await rateFor(trip);
  const price = rate.price as { amountMinor: number; currencyId: unknown };
  const from = await currencyUnits(price.currencyId);
  const to = await currencyUnits(currencyId);
  const convert = async (minor: number, fromId: string, fromUnits: number) => {
    if (fromId === to.id) return minor;
    return applyRate(minor, await rateOrRefuse(fromId, to.id, date), fromUnits, to.minorUnits);
  };
  const route = await routeLabel(trip as never);
  const taxPercent = taxPercentFor(settings, rate);
  const lines: PricedLine[] = [];
  const consignments = await Consignment.find({ tripId: trip._id }).sort({ loadedAt: 1 }).lean() as Plain[];
  const basis = String(rate.basis);
  // The unit price is converted with more precision than a minor unit allows, so 37,850 L × 0.0123 USD stays right.
  const unitPrice = Number(price.amountMinor) * (from.id === to.id ? 1 : await rateOrRefuse(from.id, to.id, date)) * 10 ** (to.minorUnits - from.minorUnits);
  const base = { tripId: trip._id, rateId: rate._id, unit: UNIT[basis], taxPercent, kind: 'freight' as const };
  let freightMinor = 0;
  if (basis === 'per_trip' || basis === 'per_km') {
    const qty = basis === 'per_trip' ? 1 : loadedKm(trip);
    if (basis === 'per_km' && !qty) throw refuse(`${trip.number} has no loaded km to charge.`);
    lines.push({ ...base, description: `${trip.number} · ${route}`, qty, unitPriceMinor: unitPrice });
    freightMinor = Math.round(qty * Number(price.amountMinor));
  } else {
    for (const c of consignments) {
      const measure = (settings.billOn === 'loaded' ? c.load : c.delivered ?? undefined) as Plain | undefined;
      const qty = await quantity(basis, measure, c.productId, `Consignment ${c.number}`);
      lines.push({ ...base, consignmentId: c._id, description: `${trip.number} · ${route} · ${settings.billOn === 'loaded' ? 'loaded' : 'delivered'}`, qty, unitPriceMinor: unitPrice });
      freightMinor += Math.round(qty * Number(price.amountMinor));
    }
    if (!lines.length) throw refuse(`Nothing was loaded on ${trip.number}.`);
  }
  const minimum = rate.minimumCharge as { amountMinor: number } | undefined;
  if (minimum && freightMinor < minimum.amountMinor) {
    lines.push({ ...base, kind: 'minimum', description: `${trip.number} · up to the minimum charge`, qty: 1, unit: undefined, unitPriceMinor: await convert(minimum.amountMinor - freightMinor, from.id, from.minorUnits) });
  }
  if (settings.shortageOnInvoice === 'deduct') {
    for (const c of consignments) {
      const s = c.shortage as { netShortL?: number; pricePerL?: { amountMinor: number; currencyId: unknown } } | undefined;
      if (!s?.netShortL || s.netShortL <= 0 || !s.pricePerL) continue;
      const per = await currencyUnits(s.pricePerL.currencyId);
      const unit = Number(s.pricePerL.amountMinor) * (per.id === to.id ? 1 : await rateOrRefuse(per.id, to.id, date)) * 10 ** (to.minorUnits - per.minorUnits);
      lines.push({ kind: 'shortage', tripId: trip._id, consignmentId: c._id, description: `${trip.number} · shortage beyond the allowance`, qty: round3(s.netShortL), unit: 'L', unitPriceMinor: -unit, taxPercent });
    }
  }
  return lines;
}
