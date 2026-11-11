import type { Rec } from "../api/adapter";

/**
 * A consignment as the consignment screens read it (#135, the API contract's section 1): its goods lines, its own
 * pickups and drops, its papers and its revenue. The older `Consignment` in domain/types keeps the one-load shape
 * the trip's stage panels still read, for loaded consignments only, until those panels move to this one.
 */

export type CnStatus = "draft" | "booked" | "assigned" | "loading" | "loaded" | "in_transit" | "delivering" | "delivered" | "closed" | "cancelled" | "returning" | "returned" | "written_off";
export type RevenueStatus = "unpriced" | "estimated" | "priced" | "frozen" | "invoiced";

export interface Contact { name: string; phone?: string; whatsapp?: string; email?: string; address?: string; taxId?: string }
export interface Money { amountMinor: number; currencyId: string }

export interface CnLine {
  id: string;
  productId: string;
  description?: string;
  plannedQty?: number;
  unit: string;
  pieces?: number;
  grossKg?: number;
  volumeM3?: number;
  declaredValue?: Money;
  hazard?: boolean;
}

export interface CnMeasure {
  lineId: string;
  qty: number;
  unit: string;
  ambientL?: number;
  tempC?: number;
  density?: number;
  vcf?: number;
  std20L?: number;
  certStd20L?: number;
  gross?: number;
  tare?: number;
  ticketNo?: string;
  pieces?: number;
  accepted?: number;
  damaged?: number;
  shortDelivered?: number;
  docIds?: string[];
}

export interface CnLeg {
  id: string;
  kind: "pickup" | "drop";
  sequence: number;
  /** Empty: a drop to be confirmed (a late split), with no stop yet. */
  placeId: string | null;
  stopId: string | null;
  status: "planned" | "done" | "skipped";
  plannedAt?: string;
  planned?: { lineId: string; qty?: number; pieces?: number }[];
  actual?: CnMeasure[];
  recordedAt?: string;
  recordedBy?: string;
  pod?: { number?: string; receivedBy?: string; receivedAt?: string; remarks?: string; docIds?: string[] };
  /** Gate in, work started and finished, gate out, and the wait before the work (#102). */
  times?: { arrivedAt?: string; startedAt?: string; finishedAt?: string; leftAt?: string; waitedMinutes?: number };
  loading?: { orderNo?: string; bay?: string; supervisor?: string };
  outcome?: "delivered" | "partial" | "refused";
  contact?: Contact;
  note?: string;
}

export interface CnDocument {
  id: string;
  documentTypeId: string;
  label?: string;
  number?: string;
  date?: string;
  legId?: string;
  driverDocId?: string;
  fileId?: string;
  amount?: Money;
  validUntil?: string;
  at?: string;
  by?: string;
}

export interface RevenueLine {
  id: string;
  chargeTypeId: string;
  kind: "freight" | "minimum" | "charge" | "deduction";
  description: string;
  qty?: number;
  unit?: string;
  unitPriceMinor?: number;
  amountMinor: number;
  taxPercent?: number;
  taxMinor?: number;
  source: "tariff" | "auto" | "manual";
  tariffLineId?: string;
  legId?: string;
  lineId?: string;
  formula?: string;
  variables?: Record<string, number | string | boolean>;
  accepted: boolean;
  note?: string;
}

export interface Revenue {
  status: RevenueStatus;
  tariffId?: string;
  tariffVersion?: number;
  currencyId?: string;
  pricedOn?: string;
  basis?: { chargeOn?: string; qty?: number; unit?: string; km?: number; pieces?: number; drops?: number; estimated?: boolean };
  lines: RevenueLine[];
  subtotalMinor?: number;
  taxMinor?: number;
  totalMinor?: number;
  baseSubtotalMinor?: number;
  baseTotalMinor?: number;
  rateToBase?: number;
  manual?: { reason?: string; whole?: boolean; at?: string; by?: string };
  frozenAt?: string;
  invoiceIds?: string[];
  explanation: string[];
  problem?: string | null;
  tariff?: { id: string; code: string; name?: string; version?: number; matchedOn?: string } | null;
}

/** Goods the consignee refused at a drop (#102), waiting for the office to say what happens to them. */
export interface CnRefusal {
  id: string; legId: string; lineId: string; qty: number; unit: string; reason?: string; at: string;
  status: "to_decide" | "decided"; outcome?: "return" | "write_off" | "charge_driver" | "claim_supplier"; note?: string; decidedAt?: string;
  amount?: { amountMinor: number; currencyId: string; baseAmountMinor: number };
}
export const REFUSAL_OUTCOME: Record<NonNullable<CnRefusal["outcome"]>, string> = {
  return: "Bring it back", write_off: "Write it off (the company's loss)", charge_driver: "Charge the driver, like a shortage", claim_supplier: "Claim it from the supplier",
};

export interface Cn {
  id: string;
  number: string;
  version: number;
  refusals?: CnRefusal[];
  consignmentTypeId?: string;
  status: CnStatus;
  customerId: string;
  consignorPartyId?: string | null;
  consignor?: Contact | null;
  consigneePartyId?: string | null;
  consignee?: Contact | null;
  brokerPartyId?: string | null;
  paymentTerms?: "to_be_billed" | "paid" | "to_pay";
  tripId?: string | null;
  bookedAt: string;
  loadedAt?: string | null;
  deliveredAt?: string | null;
  leadKm?: number | null;
  lines: CnLine[];
  legs: CnLeg[];
  documents: CnDocument[];
  /** The rate agreed for it (#135 Part 1); unit prices keep fractions of a minor unit. */
  rate?: { basis: string; price: Money; chargeOn?: "loaded" | "delivered" };
  references?: { customerRef?: string; orderNo?: string; lrNo?: string; ewayBillNo?: string; ewayBillValidUntil?: string; sealNos?: string[]; permitNo?: string; leadKm?: number };
  /** Left out for people who may not see money. */
  revenue?: Revenue;
  custom?: Record<string, unknown>;
  /** Names, worked out from the party records, for lists. */
  consignorName: string;
  consigneeName: string;
  consigneePhone?: string;
}

/** The new shape from the server, with party names put in for the lists. */
export function cnFrom(c: Rec, partyName: (id: unknown) => string | undefined, partyPhone: (id: unknown) => string | undefined): Cn {
  const consignor = (c.consignor ?? null) as Contact | null;
  const consignee = (c.consignee ?? null) as Contact | null;
  return {
    ...(c as unknown as Cn),
    lines: (c.lines ?? []) as CnLine[],
    legs: ((c.legs ?? []) as CnLeg[]).slice().sort((a, b) => a.sequence - b.sequence),
    documents: (c.documents ?? []) as CnDocument[],
    consignorName: consignor?.name ?? partyName(c.consignorPartyId) ?? partyName(c.customerId) ?? "—",
    consigneeName: consignee?.name ?? partyName(c.consigneePartyId) ?? partyName(c.customerId) ?? "—",
    consigneePhone: consignee?.phone ?? partyPhone(c.consigneePartyId),
  };
}

export const CN_STATUS_LABEL: Record<CnStatus, string> = {
  draft: "Draft", booked: "Booked", assigned: "On a trip", loading: "Loading", loaded: "Loaded", in_transit: "On the road", delivering: "Delivering",
  delivered: "Delivered", closed: "Closed", cancelled: "Cancelled", returning: "Going back", returned: "Returned", written_off: "Written off",
};
export const cnStatusTone = (s: CnStatus): "ok" | "wait" | "bad" | "info" | "mute" =>
  s === "delivered" || s === "closed" ? "ok" : s === "cancelled" || s === "written_off" ? "mute" : s === "returning" || s === "returned" ? "bad" : s === "draft" || s === "booked" || s === "assigned" ? "wait" : "info";

export const REVENUE_LABEL: Record<RevenueStatus, string> = { unpriced: "Unpriced", estimated: "Estimated", priced: "Priced", frozen: "Frozen", invoiced: "Invoiced" };
export const revenueTone = (s: RevenueStatus): "ok" | "wait" | "bad" | "info" | "mute" =>
  s === "unpriced" ? "bad" : s === "estimated" ? "wait" : s === "invoiced" ? "mute" : "ok";

/** Planned, loaded and delivered totals in the first line's unit (lines in other units are not added in). */
export function cnTotals(c: Cn) {
  const unit = c.lines[0]?.unit ?? "";
  const sameUnit = (m: { unit?: string }) => !m.unit || m.unit === unit;
  const planned = c.lines.filter(sameUnit).reduce((s, l) => s + (l.plannedQty ?? 0), 0);
  const measured = (kind: "pickup" | "drop") => c.legs.filter((l) => l.kind === kind && l.status === "done").flatMap((l) => l.actual ?? []).filter(sameUnit);
  const loaded = measured("pickup").reduce((s, m) => s + m.qty, 0);
  const delivered = measured("drop").reduce((s, m) => s + (m.accepted ?? m.qty), 0);
  return { unit, planned, loaded: measured("pickup").length ? loaded : undefined, delivered: measured("drop").length ? delivered : undefined };
}

/** Whether a consignment's type lets it be dropped at several places (a split), from the type's own record. */
export function maySplit(c: Cn, types: Record<string, unknown>[] | undefined): boolean {
  const t = types?.find((x) => x.id === c.consignmentTypeId);
  return Boolean(t?.multiDrop);
}
