import type { AppData, Settings } from "./types";

/**
 * The company's words and stages (#73). The server sends them with the reference data (/meta/workspace); these
 * defaults only stand in until it has, and match the server's.
 */
export const DEFAULT_WORDS: Settings["words"] = {
  trip: { singular: "Trip", plural: "Trips" },
  nomination: { singular: "Nomination", plural: "Nominations" },
  driver: { singular: "Driver", plural: "Drivers" },
  truck: { singular: "Truck", plural: "Trucks" },
  trailer: { singular: "Trailer", plural: "Trailers" },
  customer: { singular: "Customer", plural: "Customers" },
  advance: { singular: "Cash advance", plural: "Cash advances" },
  fuelRequest: { singular: "Fuel request", plural: "Fuel requests" },
  expense: { singular: "Expense", plural: "Expenses" },
  settlement: { singular: "Settlement", plural: "Settlements" },
  statement: { singular: "Statement", plural: "Statements" },
  tripSheet: { singular: "Trip sheet", plural: "Trip sheets" },
  consignment: { singular: "Consignment", plural: "Consignments" },
  consignmentNote: { singular: "Consignment note", plural: "Consignment notes" },
};

export const DEFAULT_STAGES: Settings["stages"] = [
  { key: "plan", name: "Plan", on: true },
  { key: "funding", name: "Funding", on: true },
  { key: "loading", name: "Loading", on: true },
  { key: "transit", name: "Transit", on: true },
  { key: "offloading", name: "Offloading", on: true },
  { key: "close", name: "Close", on: true },
  { key: "settle", name: "Settlement", on: true },
];

export const DEFAULT_DESKS: Settings["desks"] = [
  { key: "owner", name: "Overview and approvals", icon: "gauge", views: ["overview", "trips", "nominations", "accounts", "maintenance", "billing", "masters"], kind: "owner", actsAs: "owner" },
  { key: "operations", name: "Operations", icon: "grid", views: ["trips", "nominations", "accounts", "maintenance", "masters"], kind: "operations", actsAs: "operations" },
  { key: "finance", name: "Finance", icon: "wallet", views: ["today", "trips", "accounts", "billing", "masters"], kind: "finance", actsAs: "finance" },
];

/** A term as the company says it: `w(data, "trip")` → "Job", `w(data, "trip", true)` → "Jobs". */
export const w = (data: AppData | undefined, term: string, plural = false) => {
  const entry = data?.settings.words?.[term] ?? DEFAULT_WORDS[term];
  return entry ? (plural ? entry.plural : entry.singular) : term;
};
/** The same in lower case, for the middle of a sentence ("Approve the cash advance"). */
export const wl = (data: AppData | undefined, term: string, plural = false) => w(data, term, plural).toLowerCase();

/** Whether the company works this stage (Funding and Settlement can be off; Money off turns them off too). */
export const stageOn = (data: AppData | undefined, key: string) => (data?.settings.stages ?? DEFAULT_STAGES).find((s) => s.key === key)?.on !== false;
export const stageName = (data: AppData | undefined, key: string) => (data?.settings.stages ?? DEFAULT_STAGES).find((s) => s.key === key)?.name ?? key;
