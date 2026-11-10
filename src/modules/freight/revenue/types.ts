/**
 * The revenue engine's inputs and output (#130, consignments design 3.5). Plain data only, with ids as strings: the
 * freight module's adapter (`src/modules/freight/pricing.ts`) reads the database, matches the tariff and builds these;
 * the engine never touches the database or the clock, so one set of facts always gives one answer.
 *
 * The enums are copied from the models of #135 (`freight.model.ts`, `cargo.model.ts`) so this module stays free of
 * Mongoose. Keep the two in step: a basis added there needs pricing here.
 */

export type Id = string;

export const RATE_BASES = [
  'per_consignment', 'per_trip', 'per_tonne', 'per_kg', 'per_litre', 'per_litre_20', 'per_m3', 'per_piece', 'per_km', 'per_tonne_km',
  'per_drop_beyond', 'shortage_beyond_allowance',
] as const;
export type RateBasis = (typeof RATE_BASES)[number];
export const CHARGE_ON = ['loaded', 'delivered', 'planned', 'greater_of', 'lesser_of'] as const;
export type ChargeOn = (typeof CHARGE_ON)[number];
export const DISTANCE_SOURCES = ['route_lead', 'trip_loaded_km', 'manual'] as const;
export type DistanceSource = (typeof DISTANCE_SOURCES)[number];
export const SHORTAGE_DEDUCTIONS = ['none', 'beyond_allowance', 'all'] as const;
export type ShortageDeduction = (typeof SHORTAGE_DEDUCTIONS)[number];
export const REVENUE_STATUSES = ['unpriced', 'estimated', 'priced', 'frozen', 'invoiced'] as const;
export type RevenueStatus = (typeof REVENUE_STATUSES)[number];
export const REVENUE_LINE_KINDS = ['freight', 'minimum', 'charge', 'deduction'] as const;
export type RevenueLineKind = (typeof REVENUE_LINE_KINDS)[number];
export type LineSource = 'tariff' | 'auto' | 'manual';

export interface Money { amountMinor: number; currencyId: Id }
export interface CurrencyUnits { id: Id; code: string; minorUnits: number }

/* ---------- The tariff (freight.model.ts `Tariff`, already matched) ---------- */

export interface TariffLineInput {
  id: Id;
  chargeTypeId: Id;
  description?: string;
  basis: RateBasis;
  /** Per unit of the basis, or the flat amount, in the tariff's currency. */
  price?: Money;
  /** Free drops before an extra-drop charge starts (default 1). */
  freeQty?: number;
  minimum?: Money;
  maximum?: Money;
  taxRatePercent?: number;
  order?: number;
}

export interface TariffInput {
  id: Id;
  code: string;
  name?: string;
  /** The master's version, kept on the revenue so a later edit doesn't move history. */
  version?: number;
  currencyId: Id;
  chargeOn?: ChargeOn;
  distanceSource?: DistanceSource;
  shortageDeduction?: ShortageDeduction;
  shortageAllowancePercent?: number;
  taxRatePercent?: number;
  lines: TariffLineInput[];
  minimumCharge?: Money;
  /** What it matched on, in words, for the explanation: "customer and route". */
  matchedOn?: string;
}

export interface ChargeTypeInput {
  id: Id;
  code: string;
  name: string;
  kind: RevenueLineKind;
  /** A cost line (a broker's commission) is worked out but never billed to the customer. */
  direction?: 'revenue' | 'cost';
  taxable?: boolean;
  printLabel?: string;
}

/** Company → Freight and the Money settings the engine reads (`freightSettings()`, `billingSettings()`). */
export interface EngineSettings {
  chargeOnDefault: ChargeOn;
  distanceSourceDefault: DistanceSource;
  shortageDeductionDefault: ShortageDeduction;
  tax: { mode: 'none' | 'single' | 'per_customer_product' | string; ratePercent: number; pricesIncludeTax: boolean };
  /** The active charge types; `MINIMUM` and `SHORTAGE_DEDUCTION` are found by code when no tariff line names them. */
  chargeTypes: ChargeTypeInput[];
}

/* ---------- The consignment (cargo.model.ts `Consignment`) ---------- */

/** One recorded measure for one goods line (`legMeasureSchema`). */
export interface FactMeasure {
  lineId: Id;
  qty: number;
  unit: string;
  ambientL?: number;
  tempC?: number;
  /** As measured: kg/m³ (835) on a fuel reading, or kg/L. */
  density?: number;
  std20L?: number;
  certStd20L?: number;
  gross?: number;
  tare?: number;
  pieces?: number;
  /** Drops: what the consignee took, in the line's unit, when not everything. */
  accepted?: number;
  damaged?: number;
}

export interface FactLeg {
  id: Id;
  kind: 'pickup' | 'drop';
  status: 'planned' | 'done' | 'skipped';
  outcome?: 'delivered' | 'partial' | 'refused';
  /** For the explanation. */
  placeName?: string;
  planned?: Array<{ lineId: Id; qty?: number; pieces?: number }>;
  actual?: FactMeasure[];
}

export interface FactLine {
  id: Id;
  productId: Id;
  productName?: string;
  plannedQty?: number;
  unit: string;
  pieces?: number;
  grossKg?: number;
  volumeM3?: number;
  product: {
    /** Fuel: compared and charged at 20 °C. */
    volumeCorrected?: boolean;
    densityKgPerL?: number;
    /** Decimals the product is measured in (fuel litres: 0). */
    decimals?: number;
    /** The driver-side allowance for this product, when it has its own. */
    shortageAllowancePercent?: number;
    /** What a unit lost costs, already in the tariff's currency (minor units; fractions kept). */
    shortagePricePerUnitMinor?: number;
  };
}

/** The revenue as it was saved, so a person's work survives and a frozen price stays put (design 3.5.8). */
export interface PreviousRevenue {
  status: RevenueStatus;
  lines: RevenueLine[];
  manual?: { reason?: string; whole?: boolean };
  frozenAt?: Date | string;
  [key: string]: unknown;
}

export interface PricingFacts {
  /** The consignment's number, for the sentences: "CN-0412". */
  number: string;
  /** The day whose tariff and exchange rate apply (`priceOn`). */
  pricedOn: Date | string;
  /** The tariff's currency (or a manual price's). */
  currency: CurrencyUnits;
  /** The company's base currency and the rate from `currency` on `pricedOn`; `rate` empty when none is recorded. */
  base?: CurrencyUnits & { rate?: number | null };
  lines: FactLine[];
  legs: FactLeg[];
  distance: { leadKm?: number; tripLoadedKm?: number; manualKm?: number };
  /** A per-trip price is carried by the customer's first consignment on the trip; the others say where it is. */
  perTrip?: { carries: boolean; carrierNumber?: string };
  /** The company's driver-side allowance, the customer-side one when the tariff names none. */
  shortageAllowancePercent?: number;
  previous?: PreviousRevenue;
}

/* ---------- The output (cargo.model.ts `revenueSchema`) ---------- */

export interface RevenueLine {
  chargeTypeId: Id;
  kind: RevenueLineKind;
  description: string;
  qty?: number;
  unit?: string;
  /** In the revenue's currency; fractions of a minor unit are kept. Negative for a deduction. */
  unitPriceMinor?: number;
  amountMinor: number;
  taxPercent?: number;
  taxMinor?: number;
  source: LineSource;
  tariffLineId?: Id;
  legId?: Id;
  accepted: boolean;
  note?: string;
  by?: Id;
}

export interface RevenueBasis {
  chargeOn: ChargeOn;
  qty?: number;
  unit?: string;
  km?: number;
  pieces?: number;
  drops?: number;
  estimated: boolean;
}

export interface RevenueResult {
  status: RevenueStatus;
  tariffId?: Id;
  tariffVersion?: number;
  currencyId?: Id;
  pricedOn?: Date;
  basis?: RevenueBasis;
  lines: RevenueLine[];
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  baseSubtotalMinor?: number;
  baseTotalMinor?: number;
  rateToBase?: number;
  explanation: string[];
  problem?: string;
  /** The engine left a frozen or invoiced revenue exactly as it was. */
  unchanged?: boolean;
}
