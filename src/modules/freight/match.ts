import type { Plain } from '../../core/masters/types.js';
import { Tariff } from './models/freight.model.js';

/**
 * Which tariff prices a consignment (design 3.4.5, "Matching"). Candidates are the active tariffs valid on the pricing
 * day whose every condition holds; the most specific wins (the weights below), then the higher priority, then the
 * latest start. A tariff for a customer and a route beats one for the customer alone.
 */

/** What a tariff's conditions are compared with. Each is an id as text, or empty when the consignment has none. */
export interface MatchSubject {
  customerId?: string; consignorPartyId?: string; consignmentTypeId?: string; routeId?: string;
  fromPlaceId?: string; toPlaceId?: string; fromCountryId?: string; toCountryId?: string;
  /** Every product and product group on the consignment: a tariff for one of them applies. */
  productIds?: string[]; productGroupIds?: string[];
  vehicleTypeId?: string;
}

/** How much each condition counts. The design names customer, route, place, product, type and vehicle type; the rest sit between. */
export const MATCH_WEIGHTS = {
  customerId: 16, consignorPartyId: 12, routeId: 8, fromPlaceId: 6, toPlaceId: 6, fromCountryId: 3, toCountryId: 3,
  productId: 4, productGroupId: 3, consignmentTypeId: 2, vehicleTypeId: 1,
} as const;
type Condition = keyof typeof MATCH_WEIGHTS;

const WORDS: Record<Condition, string> = {
  customerId: 'customer', consignorPartyId: 'consignor', routeId: 'route', fromPlaceId: 'from place', toPlaceId: 'to place', fromCountryId: 'from country',
  toCountryId: 'to country', productId: 'product', productGroupId: 'product group', consignmentTypeId: 'consignment type', vehicleTypeId: 'vehicle type',
};

const str = (v: unknown) => (v == null || v === '' ? undefined : String(v));
const startOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** Whether a tariff's dates cover the day: from its start (any time that day) to the end of its last day. */
export function validOn(tariff: Plain, day: Date) {
  const from = tariff.validFrom ? new Date(tariff.validFrom as string) : undefined;
  const to = tariff.validTo ? new Date(tariff.validTo as string) : undefined;
  if (from && startOfDay(from) > day) return false;
  if (to && startOfDay(to).getTime() + 86_400_000 <= startOfDay(day).getTime()) return false;
  return true;
}

/** The conditions a tariff sets that the consignment meets, or null when one it sets is not met. */
export function conditionsMet(tariff: Plain, s: MatchSubject): Condition[] | null {
  const met: Condition[] = [];
  for (const key of Object.keys(MATCH_WEIGHTS) as Condition[]) {
    const wanted = str(tariff[key]);
    if (!wanted) continue;
    const ok = key === 'productId' ? (s.productIds ?? []).includes(wanted)
      : key === 'productGroupId' ? (s.productGroupIds ?? []).includes(wanted)
        : str((s as Plain)[key]) === wanted;
    if (!ok) return null;
    met.push(key);
  }
  return met;
}

export interface Match { tariff: Plain; score: number; matchedOn: string }

/** The winning tariff among those given, or null. Pure, for tests and the tariff editor. */
export function matchTariff(tariffs: Plain[], s: MatchSubject, day: Date): Match | null {
  const scored: Match[] = [];
  for (const t of tariffs) {
    if (t.status && t.status !== 'active') continue;
    if (!validOn(t, day)) continue;
    const met = conditionsMet(t, s);
    if (!met) continue;
    scored.push({ tariff: t, score: met.reduce((sum, k) => sum + MATCH_WEIGHTS[k], 0), matchedOn: met.length ? met.map((k) => WORDS[k]).join(' and ') : 'a rate card for everyone' });
  }
  scored.sort((a, b) => b.score - a.score || Number(b.tariff.priority ?? 0) - Number(a.tariff.priority ?? 0)
    || +new Date((b.tariff.validFrom ?? 0) as string) - +new Date((a.tariff.validFrom ?? 0) as string));
  return scored[0] ?? null;
}

/** The tariff for a consignment on its pricing day, read from the database. */
export async function tariffFor(s: MatchSubject, day: Date): Promise<Match | null> {
  // Only tariffs that could match: for this customer or for everyone.
  const candidates = await Tariff.find({ status: 'active', $or: [{ customerId: { $exists: false } }, { customerId: null }, ...(s.customerId ? [{ customerId: s.customerId }] : [])] }).lean() as Plain[];
  return matchTariff(candidates, s, day);
}
