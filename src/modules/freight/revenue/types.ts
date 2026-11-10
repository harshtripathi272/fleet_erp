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
  // The full rate engine (design 3.5.2, phase 3).
  'percent_of_freight', 'percent_of_value', 'formula', 'per_pickup_beyond', 'damage_value',
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

/** One band of a slab rate: up to `upTo` units (empty: everything above the bands before it) at `price` per unit. */
export interface Slab { upTo?: number | null; price: Money }
export const SLAB_MODES = ['progressive', 'whole'] as const;
export type SlabMode = (typeof SLAB_MODES)[number];
export interface CurrencyUnits { id: Id; code: string; minorUnits: number }

/* ---------- The tariff (freight.model.ts `Tariff`, already matched) ---------- */

export interface TariffLineInput {
  id: Id;
  chargeTypeId: Id;
  description?: string;
  basis: RateBasis;
  /** Per unit of the basis, or the flat amount, in the tariff's currency. */
  price?: Money;
  /**
   * Bands instead of one price: `progressive` prices each band's units at its own price (500 × 12 + 499 × 10);
   * `whole` prices every unit at the band the quantity falls in.
   */
  slabs?: Slab[];
  slabMode?: SlabMode;
  /** For the percent bases: 5 is 5 %. */
  percent?: number;
  /** A condition in the formula language: the line applies only when it holds (`packaging = "CONT20"`). */
  when?: string;
  /** basis `formula`: the amount, in the tariff's currency (major units: 1.8 is USD 1.80). */
  formula?: string;
  /** Free drops (or pickups) before an extra-drop (or extra-pickup) charge starts (default 1). */
  freeQty?: number;
  /** Worked out once per goods line, each with its own quantity, for mixed goods at different rates. */
  perLine?: boolean;
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
  /** Chargeable weight (3.5.4): kg per m³ for volumetric weight, the least kg charged, and the step kg round up to. */
  volumetricDivisorKgPerM3?: number;
  minimumChargeableKg?: number;
  roundQtyUpTo?: number;
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
  /**
   * The engine adds it by itself, from its default basis and price, when the facts for it exist and the tariff has
   * no line of this type (an extra pickup, damaged goods). Finance can switch it off before invoicing.
   */
  autoApply?: boolean;
  defaultBasis?: RateBasis;
  defaultPrice?: Money;
  defaultPercent?: number;
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
  /** For conditions: `line.product = "AGO"`. */
  productCode?: string;
  plannedQty?: number;
  unit: string;
  pieces?: number;
  grossKg?: number;
  volumeM3?: number;
  /** Already in the tariff's currency (minor units). */
  declaredValueMinor?: number;
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
  /** Lead distance; the trip's loaded km (first loading to last offloading); a typed one; the whole trip. */
  distance: { leadKm?: number; tripLoadedKm?: number; manualKm?: number; tripKm?: number };
  /** A per-trip price is carried by the customer's first consignment on the trip; the others say where it is. */
  perTrip?: { carries: boolean; carrierNumber?: string };
  /** The company's driver-side allowance, the customer-side one when the tariff names none. */
  shortageAllowancePercent?: number;
  /**
   * Codes a formula's condition may compare, as text: product, productGroup, packaging, type, route, vehicleType,
   * fromPlace, toPlace, fromCountry, toCountry, paymentTerms.
   */
  codes?: Partial<Record<CodeName, string>>;
  /** The company's own fields on the consignment, read as `custom.<key>`. */
  custom?: Record<string, number | string | boolean | null | undefined>;
  /** The fuel price per litre on the pricing day, for fuel-linked surcharges (major units, as the adapter states). */
  fuelPrice?: number;
  /** Days from the first pickup to the last drop, when both are known. */
  days?: number;
  previous?: PreviousRevenue;
}

export const CODE_NAMES = ['product', 'productGroup', 'packaging', 'type', 'route', 'vehicleType', 'fromPlace', 'toPlace', 'fromCountry', 'toCountry', 'paymentTerms'] as const;
export type CodeName = (typeof CODE_NAMES)[number];

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
  /** The goods line it prices, for a tariff line worked out per goods line. */
  lineId?: Id;
  /** A formula line keeps what it computed and what it saw, so the figure can be explained years later (3.5.6). */
  formula?: string;
  variables?: Record<string, number | string | boolean>;
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
