import type { ChargeOn, FactLeg, FactLine, FactMeasure, PricingFacts, RateBasis } from './types.js';

/**
 * Quantities for pricing (consignments design 3.5.4): what was planned, loaded and delivered, in every measure a
 * rate may be charged in, and how each was reached. Pure.
 */

const LITRES = /^(l|ltr|ltrs|litres?|liters?)$/i;
const CUBIC = /^(m3|m³|cbm|cum)$/i;
const KG = /^(kg|kgs|kilograms?)$/i;
const TONNES = /^(t|mt|tonnes?|tons?)$/i;

export const round3 = (n: number) => Math.round(n * 1000) / 1000;
const roundTo = (n: number, decimals: number) => Math.round(n * 10 ** decimals) / 10 ** decimals;

/** One quantity in every measure it can be expressed in; a measure is missing when some part of it can't be. */
export interface Amounts {
  /** In the line's own unit. */
  qty: number;
  litres20?: number;
  litres?: number;
  kg?: number;
  pieces?: number;
  /** How kg was reached, when it was converted: "density 0.835 kg/L". */
  kgVia?: string;
}

const kgPerLitre = (density: number | undefined) => (density === undefined || !(density > 0) ? undefined : density > 10 ? density / 1000 : density);

/** A measure in every unit it can be read in, for its goods line. `share` scales a drop to what the consignee accepted. */
export function amountsOf(m: Pick<FactMeasure, 'qty' | 'unit'> & Partial<FactMeasure>, line: FactLine, share = 1): Amounts {
  const unit = m.unit || line.unit;
  const qty = Number(m.qty) * share;
  const litresAsMeasured = m.ambientL !== undefined ? m.ambientL * share : LITRES.test(unit) ? qty : CUBIC.test(unit) ? qty * 1000 : undefined;
  const litres20 = m.certStd20L !== undefined ? m.certStd20L * share : m.std20L !== undefined ? m.std20L * share : LITRES.test(unit) ? qty : undefined;
  let kg: number | undefined;
  let kgVia: string | undefined;
  if (KG.test(unit)) kg = qty;
  else if (TONNES.test(unit)) kg = qty * 1000;
  else {
    const volume = litres20 ?? litresAsMeasured;
    const measured = kgPerLitre(m.density);
    const own = kgPerLitre(line.product.densityKgPerL);
    if (volume !== undefined && (measured ?? own) !== undefined) {
      kg = volume * (measured ?? own)!;
      kgVia = measured !== undefined ? `the measured density, ${round3(measured)} kg/L` : `the product's density, ${round3(own!)} kg/L`;
    } else if (line.grossKg !== undefined && line.plannedQty) {
      kg = (line.grossKg * qty) / line.plannedQty;
      kgVia = 'the booked gross weight';
    }
  }
  const counted = !LITRES.test(unit) && !CUBIC.test(unit) && !KG.test(unit) && !TONNES.test(unit);
  const pieces = m.pieces !== undefined ? m.pieces * share : counted ? qty : line.pieces !== undefined && line.plannedQty ? (line.pieces * qty) / line.plannedQty : undefined;
  return { qty, litres20, litres: litresAsMeasured, kg, pieces, ...(kgVia ? { kgVia } : {}) };
}

/** Adds amounts; a measure stays only when every part has it. */
export function sum(parts: Amounts[]): Amounts | undefined {
  if (!parts.length) return undefined;
  const all = (k: 'litres20' | 'litres' | 'kg' | 'pieces') => (parts.every((p) => p[k] !== undefined) ? parts.reduce((s, p) => s + p[k]!, 0) : undefined);
  const via = parts.map((p) => p.kgVia).find(Boolean);
  return { qty: parts.reduce((s, p) => s + p.qty, 0), litres20: all('litres20'), litres: all('litres'), kg: all('kg'), pieces: all('pieces'), ...(via ? { kgVia: via } : {}) };
}

const live = (legs: FactLeg[], kind: FactLeg['kind']) => legs.filter((l) => l.kind === kind && l.status !== 'skipped');

/** The facts of one goods line alone, for a tariff line worked out per goods line. */
export function onlyLine(facts: PricingFacts, line: FactLine): PricingFacts {
  return {
    ...facts,
    lines: [line],
    legs: facts.legs.map((l) => ({
      ...l,
      ...(l.planned ? { planned: l.planned.filter((p) => p.lineId === line.id) } : {}),
      ...(l.actual ? { actual: l.actual.filter((m) => m.lineId === line.id) } : {}),
    })),
  };
}

/** Where the consignment stands: what is done, and what is still to come. */
export function progress(facts: PricingFacts) {
  const pickups = live(facts.legs, 'pickup');
  const drops = live(facts.legs, 'drop');
  const pickedUp = pickups.length > 0 && pickups.every((l) => l.status === 'done');
  const dropped = drops.length > 0 && drops.every((l) => l.status === 'done');
  return { pickups, drops, anyPickupDone: pickups.some((l) => l.status === 'done'), pickedUp, dropped, complete: pickedUp && dropped };
}

/** Per goods line: planned, loaded so far and delivered so far. */
export function perLine(facts: PricingFacts) {
  const { pickups, drops } = progress(facts);
  return facts.lines.map((line) => {
    const measures = (legs: FactLeg[], pick: (m: FactMeasure) => Amounts | undefined) =>
      sum(legs.filter((l) => l.status === 'done').flatMap((l) => (l.actual ?? []).filter((m) => m.lineId === line.id).map(pick).filter((a): a is Amounts => !!a)));
    const plannedQty = line.plannedQty ?? (() => {
      const legsQty = pickups.flatMap((l) => l.planned ?? []).filter((p) => p.lineId === line.id && p.qty !== undefined);
      return legsQty.length ? legsQty.reduce((s, p) => s + p.qty!, 0) : undefined;
    })();
    const planned = plannedQty === undefined ? undefined
      : { ...amountsOf({ qty: plannedQty, unit: line.unit }, line), ...(line.volumeM3 !== undefined && !LITRES.test(line.unit) ? { litres: line.volumeM3 * 1000 } : {}), ...(line.grossKg !== undefined ? { kg: line.grossKg, kgVia: undefined } : {}), ...(line.pieces !== undefined ? { pieces: line.pieces } : {}) };
    const loaded = measures(pickups, (m) => amountsOf(m, line));
    // Charged as delivered: what the consignee accepted at drops that took the goods. Refused goods are not delivered.
    const delivered = measures(drops.filter((l) => l.outcome !== 'refused'), (m) => amountsOf(m, line, m.accepted !== undefined && m.qty > 0 ? m.accepted / m.qty : 1));
    // Measured at drops, whatever the consignee did: for the transit loss. Refused goods are still on the truck.
    const measuredOff = measures(drops, (m) => amountsOf(m, line));
    return { line, planned, loaded, delivered, measuredOff };
  });
}

export const UNIT_LABEL: Record<RateBasis, string> = {
  per_consignment: 'consignment', per_trip: 'trip', per_tonne: 't', per_kg: 'kg', per_litre: 'L', per_litre_20: 'L at 20 °C', per_m3: 'm³',
  per_piece: 'pieces', per_km: 'km', per_tonne_km: 't·km', per_drop_beyond: 'drops', shortage_beyond_allowance: '', percent_of_freight: '%', percent_of_value: '%', formula: '', per_pickup_beyond: 'pickups', damage_value: '',
};

/** The measure a basis charges in, from amounts, or why it can't. */
export function measureFor(basis: RateBasis, a: Amounts, number: string): { qty: number } | { problem: string } {
  switch (basis) {
    case 'per_tonne': return a.kg === undefined ? { problem: `${number} has no weight or density, so it can't be charged per tonne.` } : { qty: round3(a.kg / 1000) };
    case 'per_kg': return a.kg === undefined ? { problem: `${number} has no weight or density, so it can't be charged per kg.` } : { qty: round3(a.kg) };
    case 'per_litre_20': return a.litres20 === undefined ? { problem: `${number} is not measured in litres; a rate per litre at 20 °C needs litres.` } : { qty: round3(a.litres20) };
    case 'per_litre': return a.litres === undefined ? { problem: `${number} is not measured in litres, so it can't be charged per litre.` } : { qty: round3(a.litres) };
    case 'per_m3': return a.litres === undefined ? { problem: `${number} has no volume, so it can't be charged per cubic metre.` } : { qty: round3(a.litres / 1000) };
    case 'per_piece': return a.pieces === undefined ? { problem: `${number} has no count of pieces, so it can't be charged per piece.` } : { qty: round3(a.pieces) };
    default: return { qty: 1 };
  }
}

/** Bases charged on how much is carried, as opposed to a fixed sum, a distance or a count of drops. */
export const QUANTITY_BASES: readonly RateBasis[] = ['per_tonne', 'per_kg', 'per_litre_20', 'per_litre', 'per_m3', 'per_piece', 'per_tonne_km'];

export interface Charged {
  qty: number;
  /** Which quantity was used, in words for the explanation. */
  from: 'planned' | 'loaded' | 'delivered';
  estimated: boolean;
  /** Why it is an estimate, when it is. */
  note?: string;
}

const total = (parts: Array<Amounts | undefined>) => (parts.some((p) => p === undefined) ? undefined : sum(parts as Amounts[]));

/**
 * The quantity charged by `chargeOn` (3.5.4), read through `measure`. Before anything is loaded the planned quantity
 * stands in; while drops are still open, the loaded quantity stands in for the delivered one. Both are estimates.
 * `greater_of` and `lesser_of` compare what `measure` gives.
 */
export function chargedBy<T extends { qty: number }>(chargeOn: ChargeOn, facts: PricingFacts, measure: (a: Amounts) => T | { problem: string }):
  (T & Omit<Charged, 'qty'>) | { problem: string } {
  const lines = perLine(facts);
  const state = progress(facts);
  const use = (which: Charged['from'], estimated: boolean, note?: string): (T & Omit<Charged, 'qty'>) | { problem: string } => {
    const a = total(lines.map((l) => l[which]));
    if (!a) {
      return { problem: which === 'planned' ? `${facts.number} has no planned or loaded quantity yet, so it can't be priced.` : `${facts.number} has a goods line with nothing ${which} on it.` };
    }
    const m = measure(a);
    return 'problem' in m ? m : { ...m, from: which, estimated, ...(note ? { note } : {}) };
  };
  if (!state.pickedUp) {
    if (chargeOn === 'planned' || lines.every((l) => l.planned) || !state.anyPickupDone) return use('planned', true, state.anyPickupDone ? 'some pickups are still to come' : 'nothing is loaded yet');
    return use('loaded', true, 'some pickups are still to come');
  }
  if (chargeOn === 'planned') return use('planned', false);
  if (chargeOn === 'loaded') return use('loaded', false);
  if (!state.dropped) return use('loaded', true, 'drops are still open, so the loaded quantity stands in for the delivered one');
  if (chargeOn === 'delivered') return use('delivered', false);
  const loaded = use('loaded', false);
  const delivered = use('delivered', false);
  if ('problem' in loaded) return loaded;
  if ('problem' in delivered) return delivered;
  return (chargeOn === 'greater_of') === loaded.qty >= delivered.qty ? loaded : delivered;
}

/** The quantity a basis charges, by `chargeOn`. */
export function chargedQuantity(basis: RateBasis, chargeOn: ChargeOn, facts: PricingFacts): Charged | { problem: string } {
  const measureBasis = basis === 'per_tonne_km' ? 'per_tonne' : basis;
  return chargedBy(chargeOn, facts, (a) => measureFor(measureBasis, a, facts.number));
}

/** The whole charged quantity in every measure, for a formula's variables. */
export function chargedAmounts(chargeOn: ChargeOn, facts: PricingFacts) {
  return chargedBy(chargeOn, facts, (a) => ({ ...a }));
}

export interface WeightRules {
  volumetricDivisorKgPerM3?: number;
  minimumChargeableKg?: number;
  roundQtyUpTo?: number;
}

/** The booked volume of every goods line, when each has one. */
export function bookedM3(facts: PricingFacts): number | undefined {
  return facts.lines.every((l) => l.volumeM3 !== undefined) && facts.lines.length ? facts.lines.reduce((s, l) => s + l.volumeM3!, 0) : undefined;
}

/**
 * Chargeable weight (3.5.4): the greatest of the actual kg, the volumetric kg (m³ × the divisor) and the least
 * chargeable kg, then rounded up to the next `roundQtyUpTo`.
 */
export function chargeableKg(a: Amounts, rules: WeightRules, facts: PricingFacts):
  { kg: number; actualKg: number; volumetricKg?: number; m3?: number } | { problem: string } {
  if (a.kg === undefined) return { problem: `${facts.number} has no weight or density, so its chargeable weight can't be worked out.` };
  const m3 = a.litres !== undefined ? a.litres / 1000 : bookedM3(facts);
  const divisor = rules.volumetricDivisorKgPerM3;
  const volumetricKg = divisor && m3 !== undefined ? m3 * divisor : undefined;
  let kg = Math.max(a.kg, volumetricKg ?? 0, rules.minimumChargeableKg ?? 0);
  const step = rules.roundQtyUpTo;
  if (step && step > 0) kg = Math.ceil(round3(kg / step)) * step;
  return { kg: round3(kg), actualKg: round3(a.kg), ...(volumetricKg !== undefined ? { volumetricKg: round3(volumetricKg), m3: round3(m3!) } : {}) };
}

/** Customer-side transit loss per goods line, once the last drop is recorded (3.5.5): fuel at 20 °C, else in its own unit. */
export function losses(facts: PricingFacts) {
  return perLine(facts).flatMap(({ line, loaded, measuredOff }) => {
    if (!loaded || !measuredOff) return [];
    const corrected = !!line.product.volumeCorrected;
    const on = corrected ? loaded.litres20 : loaded.qty;
    const off = corrected ? measuredOff.litres20 : measuredOff.qty;
    if (on === undefined || off === undefined) return [];
    const decimals = corrected ? 0 : line.product.decimals ?? 3;
    return [{ line, unit: corrected ? 'L at 20 °C' : line.unit, decimals, loaded: roundTo(on, decimals), delivered: roundTo(off, decimals), loss: Math.max(0, roundTo(on - off, decimals)) }];
  });
}

export { roundTo };
