import type { Plain } from '../../core/masters/types.js';
import { Route } from '../geography/models/route.model.js';
import { validOn } from './match.js';
import { RateContract } from './models/freight.model.js';

/**
 * Finding a customer's rate contract line for a consignment (#151). A line is for one route and one product; the
 * consignment is on the route when its trip runs that route, or when the route passes its loading place and then
 * its drop. The newest contract valid on the day wins, and within it the line for the trip's own route.
 */

const id = (v: unknown) => (v == null || v === '' ? undefined : String(v));

export interface ContractQuery {
  customerId?: string;
  productIds: string[];
  /** The trip's route, when it has one. */
  routeId?: string;
  fromPlaceId?: string;
  toPlaceId?: string;
}

export interface ContractPick {
  contractId: string;
  code: string;
  name: string;
  lineId: string;
  routeId: string;
  productId: string;
  basis: string;
  chargeOn: 'loaded' | 'delivered';
  price: { amountMinor: number; currencyId: string };
}

/** Whether a route goes through the loading place and, after it, the drop. */
function routeCovers(route: Plain, from?: string, to?: string) {
  if (!from || !to) return false;
  const places = ((route.stops ?? []) as Plain[]).map((s) => id(s.placeId));
  const a = places.indexOf(from);
  return a >= 0 && places.indexOf(to, a + 1) > a;
}

/** A contract line as the rest of the app reads it. */
export function pickOf(contract: Plain, line: Plain): ContractPick {
  const price = line.price as Plain;
  return {
    contractId: String(contract._id), code: String(contract.code), name: String(contract.name), lineId: String(line._id),
    routeId: String(line.routeId), productId: String(line.productId), basis: String(line.basis), chargeOn: line.chargeOn as ContractPick['chargeOn'],
    price: { amountMinor: Number(price.amountMinor), currencyId: String(price.currencyId) },
  };
}

/** The contract line that prices this customer, product and route on the day, or null when none does. */
export async function contractLineFor(q: ContractQuery, on: Date = new Date()): Promise<ContractPick | null> {
  if (!q.customerId || !q.productIds.length) return null;
  const contracts = (await RateContract.find({ customerId: q.customerId, status: 'active' }).sort({ validFrom: -1, createdAt: -1 }).lean<Plain[]>())
    .filter((c) => validOn(c, on));
  if (!contracts.length) return null;
  const routeIds = [...new Set(contracts.flatMap((c) => ((c.lines ?? []) as Plain[]).map((l) => String(l.routeId))))];
  const routes = new Map((await Route.find({ _id: { $in: routeIds } }).select('stops').lean<Plain[]>()).map((r) => [String(r._id), r]));
  for (const contract of contracts) {
    const lines = ((contract.lines ?? []) as Plain[]).filter((l) => q.productIds.includes(String(l.productId)));
    const own = lines.find((l) => q.routeId && String(l.routeId) === q.routeId);
    const passing = own ?? lines.find((l) => routeCovers(routes.get(String(l.routeId)) ?? {}, q.fromPlaceId, q.toPlaceId));
    if (passing) return pickOf(contract, passing);
  }
  return null;
}

/** One contract line by its ids, whatever the day: the line a consignment was booked under. */
export async function contractLine(contractId: unknown, lineId: unknown): Promise<ContractPick | null> {
  const contract = contractId ? await RateContract.findById(contractId).lean<Plain>() : null;
  const line = ((contract?.lines ?? []) as Plain[]).find((l) => String(l._id) === String(lineId));
  return contract && line ? pickOf(contract, line) : null;
}

/** Whether the customer has any contract valid on the day, so a booking can say "no line for this route and product". */
export async function hasContract(customerId: string | undefined, on: Date = new Date()) {
  if (!customerId) return null;
  const list = (await RateContract.find({ customerId, status: 'active' }).select('code name validFrom validTo').sort({ validFrom: -1 }).lean<Plain[]>()).filter((c) => validOn(c, on));
  return list[0] ? { contractId: String(list[0]._id), code: String(list[0].code), name: String(list[0].name) } : null;
}
