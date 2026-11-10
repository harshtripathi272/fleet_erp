import type { Variables } from '../../../core/formula/index.js';
import { chargeableKg, chargedAmounts, bookedM3, losses, perLine, progress, round3, type WeightRules } from './quantities.js';
import { CODE_NAMES, type ChargeOn, type DistanceSource, type PricingFacts } from './types.js';

/**
 * What a tariff formula or condition may read (consignments design 3.5.6), each listed with its meaning in the
 * tariff editor. Quantities follow the tariff's `chargeOn`; money is in the tariff's currency, in major units.
 */
export const FORMULA_VARIABLES = [
  { name: 'qty', kind: 'number', help: 'The quantity charged, in the goods\' own unit' },
  { name: 'plannedQty', kind: 'number', help: 'The quantity planned' },
  { name: 'loadedQty', kind: 'number', help: 'The quantity loaded' },
  { name: 'deliveredQty', kind: 'number', help: 'The quantity delivered (what the consignees accepted)' },
  { name: 'kg', kind: 'number', help: 'The weight charged, in kg' },
  { name: 'tonnes', kind: 'number', help: 'The weight charged, in tonnes' },
  { name: 'chargeableKg', kind: 'number', help: 'The chargeable weight: the greatest of actual, volumetric and least chargeable kg' },
  { name: 'litres', kind: 'number', help: 'Litres as measured' },
  { name: 'litres20', kind: 'number', help: 'Litres at 20 °C' },
  { name: 'm3', kind: 'number', help: 'Cubic metres' },
  { name: 'pieces', kind: 'number', help: 'The count of pieces (bags, drums, pallets)' },
  { name: 'km', kind: 'number', help: 'The distance charged (by the tariff\'s distance source)' },
  { name: 'leadKm', kind: 'number', help: 'From the first pickup to the last drop along the trip' },
  { name: 'tripKm', kind: 'number', help: 'The whole trip' },
  { name: 'loadedKm', kind: 'number', help: 'The trip from its first loading to its last offloading' },
  { name: 'pickups', kind: 'number', help: 'How many pickups' },
  { name: 'drops', kind: 'number', help: 'How many drops' },
  { name: 'days', kind: 'number', help: 'Days from the first pickup to the last drop' },
  { name: 'declaredValue', kind: 'number', help: 'The goods\' declared value' },
  { name: 'freight', kind: 'number', help: 'Freight priced so far, for surcharges' },
  { name: 'shortQty', kind: 'number', help: 'Quantity lost in transit, once the last drop is in' },
  { name: 'damagedQty', kind: 'number', help: 'Quantity damaged at the drops' },
  { name: 'fuelPrice', kind: 'number', help: 'The fuel price per litre on the pricing day' },
  { name: 'product', kind: 'text', help: 'The product\'s code' },
  { name: 'productGroup', kind: 'text', help: 'The product group\'s code' },
  { name: 'packaging', kind: 'text', help: 'The packaging type\'s code' },
  { name: 'type', kind: 'text', help: 'The consignment type\'s code' },
  { name: 'route', kind: 'text', help: 'The route\'s code' },
  { name: 'vehicleType', kind: 'text', help: 'The vehicle type\'s code' },
  { name: 'fromPlace', kind: 'text', help: 'The first pickup\'s place code' },
  { name: 'toPlace', kind: 'text', help: 'The last drop\'s place code' },
  { name: 'fromCountry', kind: 'text', help: 'The first pickup\'s country code' },
  { name: 'toCountry', kind: 'text', help: 'The last drop\'s country code' },
  { name: 'paymentTerms', kind: 'text', help: 'to_be_billed, paid or to_pay' },
] as const;

/** Names a tariff formula may use, for `check()` in the tariff master's `prepare`: the list, and any `custom.` field. */
export const formulaNames = (): string[] => [...FORMULA_VARIABLES.map((v) => v.name), 'custom.'];

/** Plausible values for a dry run when a tariff is saved, so a formula of the wrong kind is caught then. */
export function sampleVariables(): Variables {
  const out: Record<string, number | string> = {};
  for (const v of FORMULA_VARIABLES) out[v.name] = v.kind === 'number' ? 1000 : 'X';
  return out;
}

export interface VariableContext {
  chargeOn: ChargeOn;
  distanceSource: DistanceSource;
  /** Freight priced so far, in minor units. */
  freightMinor: number;
  rules: WeightRules;
}

const n = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? null : round3(x));

/** The facts a formula sees. A fact that isn't known here is empty, so a formula that reads it says so. */
export function variablesFor(facts: PricingFacts, ctx: VariableContext): Variables {
  const minor = 10 ** facts.currency.minorUnits;
  const charged = chargedAmounts(ctx.chargeOn, facts);
  const amounts = 'problem' in charged ? undefined : charged;
  const lines = perLine(facts);
  const state = progress(facts);
  const qtyOf = (which: 'planned' | 'loaded' | 'delivered') => (lines.length && lines.every((l) => l[which]) ? lines.reduce((s, l) => s + l[which]!.qty, 0) : undefined);
  const weight = amounts ? chargeableKg(amounts, ctx.rules, facts) : undefined;
  const d = facts.distance;
  const km = ctx.distanceSource === 'trip_loaded_km' ? d.tripLoadedKm : ctx.distanceSource === 'manual' ? d.manualKm : d.leadKm;
  const declared = facts.lines.length && facts.lines.every((l) => l.declaredValueMinor !== undefined) ? facts.lines.reduce((s, l) => s + l.declaredValueMinor!, 0) / minor : undefined;
  const shortQty = state.complete ? losses(facts).reduce((s, l) => s + l.loss, 0) : undefined;
  const damagedQty = state.complete
    ? state.drops.flatMap((l) => l.actual ?? []).reduce((s, m) => s + (m.damaged ?? 0), 0)
    : undefined;
  const vars: Record<string, number | string | boolean | null> = {
    qty: n(amounts?.qty), plannedQty: n(qtyOf('planned')), loadedQty: n(qtyOf('loaded')), deliveredQty: n(qtyOf('delivered')),
    kg: n(amounts?.kg), tonnes: n(amounts?.kg === undefined ? undefined : amounts.kg / 1000),
    chargeableKg: n(weight && !('problem' in weight) ? weight.kg : undefined),
    litres: n(amounts?.litres), litres20: n(amounts?.litres20), m3: n(amounts?.litres !== undefined ? amounts.litres / 1000 : bookedM3(facts)),
    pieces: n(amounts?.pieces),
    km: n(km), leadKm: n(d.leadKm), tripKm: n(d.tripKm), loadedKm: n(d.tripLoadedKm),
    pickups: state.pickups.length, drops: state.drops.length, days: n(facts.days),
    declaredValue: n(declared), freight: ctx.freightMinor / minor, shortQty: n(shortQty), damagedQty: n(damagedQty),
    fuelPrice: n(facts.fuelPrice),
  };
  for (const code of CODE_NAMES) vars[code] = facts.codes?.[code] ?? null;
  for (const [key, value] of Object.entries(facts.custom ?? {})) vars[`custom.${key}`] = value ?? null;
  return vars;
}
