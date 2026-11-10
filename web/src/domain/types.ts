export type Role = "owner" | "operations" | "finance" | "driver";
export type Desk = Exclude<Role, "driver">;
export interface WorkspaceDesk {
  key: string;
  name: string;
  icon: string;
  views: string[];
  kind: Desk | "roles";
  roleKeys?: string[];
  actsAs: Desk;
}
/** An ISO currency code. The base currency comes from the company settings. */
export type Currency = string;
export type StopKind = "start" | "load" | "via" | "border" | "offload" | "end";
/** A product's unit, from the Units of measure master: "L", "t", "kg", "bags"… */
export type Unit = string;

export interface Place {
  id: string;
  name: string;
  country: string;
  lat: number;
  lng: number;
  kind: "city" | "depot" | "border";
  haltHours: number;
}
export interface Customer {
  id: string;
  name: string;
  contact: string;
  phone: string;
}
export interface Driver {
  id: string;
  name: string;
  phone: string;
  licence: string;
  /** Balance carried in from before the system went live. Positive: driver holds company cash. */
  openingBalanceBase: number;
  /** The balance from records older than the desks have loaded (#125). The server works it out. */
  carriedBase?: number;
  settleRequestedAt?: string;
  settleRequestedBy?: Role;
}
export interface Truck {
  id: string;
  plate: string;
  model: string;
  placeId: string;
  fuelL: number;
  tankL: number;
  emptyKmpl: number;
  loadedKmpl: number;
  capacityT: number;
  driverId?: string;
  trailerId?: string;
}
export interface Trailer {
  id: string;
  plate: string;
  /** The trailer type's name, e.g. "Fuel tanker". */
  type: string;
  capacity: number;
  unit: "L" | "t";
}
export interface Pairing {
  id: string;
  truckId: string;
  trailerId: string;
  from: string;
  to?: string;
}
export interface RouteStop {
  placeId: string;
  kind: StopKind;
}
export interface RouteTemplate {
  id: string;
  name: string;
  stops: RouteStop[];
  /** Road kilometres from the stop before to each stop, as the routes master has them (0 for the first). */
  legKm: number[];
  cashBudgetBase: number;
  /** Fixed fuel for the route. When empty the budget comes from distance and truck consumption. */
  fuelBudgetL?: number;
}
export interface Product {
  id: string;
  name: string;
  kind: "fuel" | "general";
  /** How it is measured: corrected to 20 °C, weighed on a weighbridge, or counted in its unit. */
  measure: "volume" | "weighed" | "counted";
  unit: Unit;
  decimals: number;
  fuelGroup?: "diesel" | "petrol" | "jet";
  /** Allowed transit loss in percent of the 20 °C loaded volume. */
  shortagePct?: number;
  /** Charge per litre of shortage beyond the allowance, in the base currency (from the product's price). */
  shortagePricePerL?: number;
}
export interface ExpenseCategory {
  id: string;
  name: string;
}
/** The Company → Freight settings the screens act on (the server's `effectiveFreight`). */
export type { Cn } from "../consignments/model";
import type { Cn } from "../consignments/model";

export interface FreightRules {
  consignmentBy: "loading" | "dispatch";
  /** 0: no limit. */
  maxConsignmentsPerTrip: number;
  consigneeMustBeParty: boolean;
  consigneePhoneRequired: boolean;
  capacityCheck: "refuse" | "warn" | "off";
  capacityTolerancePercent: number;
  lateSplit: "by_type" | "always" | "never";
  stopsEditableOnRoad: boolean;
  manualPriceNeedsReason: boolean;
  showProfitOnTripList: boolean;
}
export interface Settings {
  company: string;
  office: string;
  /** The head office's address, printed on documents. */
  officeAddress?: string;
  /** Base-currency units for one unit of each currency that has an exchange rate (the base itself is 1). */
  fx: Record<string, number>;
  /** Company trip settings: road km = straight line × this when no route gives the distance. */
  roadDistanceFactor: number;
  /** Company trip settings: average driving speed for times and ETAs. */
  averageSpeedKmh: number;
  /** Company trip settings: a trip that left but never loaded may be stopped. */
  stopBeforeLoading: boolean;
  /** Company trip settings: the kinds of cargo it carries. */
  cargoKinds: string[];
  /** Company trip settings: a loaded trip that can't deliver (#64). */
  loadedTripOutcomes: string[];
  writeOffCarriers: string[];
  writeOffDefaultCarrier: string;
  loadedTripRoles: string[];
  writeOffNeedsOwner: boolean;
  /** Company → Freight as it applies now (#135): what the consignment screens follow. */
  freight: FreightRules;
  /** The company's words for the app's core terms (#73): `words.trip.plural` and so on. */
  words: Record<string, { singular: string; plural: string }>;
  /** The desks' stages as the company names them, and which are on. */
  stages: { key: string; name: string; on: boolean }[];
  /** The company's desks (#73): each lists its screens and who sees it; `actsAs` is the built-in desk whose queues it follows. */
  desks: WorkspaceDesk[];
  clockOffsetMs: number;
  seq: Record<string, number>;
  people: Record<Desk, string>;
}

export interface Stop {
  id: string;
  placeId: string;
  kind: StopKind;
  legKm: number;
  legHours: number;
  arrivedAt?: string;
  /** Who reported the arrival; "simulator" is a demo drive. */
  arrivedVia?: ArrivalSource;
  leftAt?: string;
}
export type ArrivalSource = "office" | "driver" | "simulator" | "gps";
export interface Tracking {
  km: number;
  speed: number;
  heading: number;
  at: string;
  source?: ArrivalSource;
}
export interface Trip {
  id: string;
  /** The record version, sent back when the plan is edited. */
  version?: number;
  no: string;
  nominationId?: string;
  customerId: string;
  truckId: string;
  driverId?: string;
  trailerId?: string;
  routeId?: string;
  stops: Stop[];
  productId?: string;
  plannedQty?: number;
  plannedStart: string;
  fuelBudgetL: number;
  cashBudgetBase: number;
  openingFuelL: number;
  createdAt: string;
  dispatchedAt?: string;
  endedAt?: string;
  closingFuelL?: number;
  cancelledAt?: string;
  /** Stopped after leaving, before loading: why. The trip is closed like an ended one. */
  stopReason?: string;
  custom?: Record<string, unknown>;
  /** What was decided for a load this trip couldn't deliver. */
  undelivered?: { outcome: "return" | "transfer" | "write_off"; reason: string; at: string };
  transferredToTripId?: string;
  transferredFromTripId?: string;
  /** Cancelled after cash was paid or spent on it: it still goes on the driver's next settlement. */
  settleAfterCancel?: boolean;
  tracking?: Tracking;
  settlementId?: string;
  /** The trip type's configured stages and where the trip is (from the API). */
  stages?: { code: string; name: string; completesOn: string; completedAt?: string }[];
  stage?: { code: string; name: string; completesOn: string; done: boolean } | null;
}

export interface Decision {
  role: Role;
  what: "requested" | "approved" | "sent to owner" | "escalated" | "rejected" | "issued" | "cancelled";
  at: string;
  note?: string;
  via: "app" | "WhatsApp";
}
export interface FundRequest {
  custom?: Record<string, unknown>;
  id: string;
  no: string;
  tripId: string;
  kind: "fuel" | "cash";
  amount: number;
  currency: Currency;
  suggested: number;
  reason?: string;
  status: "pending" | "owner" | "approved" | "issued" | "rejected" | "cancelled";
  trail: Decision[];
  medium?: string;
  reference?: string;
  station?: string;
  issuedAt?: string;
  fxAtIssue?: number;
  createdAt: string;
  /** Who must decide next, and whether the signed-in person may (from the company's approval policy). */
  waitingOn?: string;
  mayDecide?: boolean;
  /** The level that lost it by not deciding in time, while it waits on the next one. */
  movedUpFrom?: string;
  level?: { current: number; of: number };
}

export interface Attachment {
  name: string;
  mime: string;
  /** An uploaded file in file storage. */
  fileId?: string;
  /** A sample picture from the simulated phone. */
  sampleId?: string;
  dataUrl?: string;
}
export type DocKind = "loading" | "delivery" | "expense" | "fuel" | "pod" | "weighbridge" | "permit" | "eway" | "other";
export interface Extracted {
  docNo?: string;
  productId?: string;
  qty?: number;
  ambientL?: number;
  tempC?: number;
  density?: number;
  certStd20L?: number;
  consignor?: string;
  consignee?: string;
  amount?: number;
  currency?: Currency;
  categoryId?: string;
  fuelL?: number;
}
export interface DriverDoc {
  id: string;
  tripId?: string;
  driverId: string;
  kind: DocKind;
  channel: "WhatsApp" | "App" | "Operations";
  note?: string;
  file?: Attachment;
  read?: Extracted;
  /** Sent from the simulated phone: a sample picture with generated figures. */
  simulated?: boolean;
  status: "new" | "recorded" | "returned";
  recordRef?: string;
  returnReason?: string;
  at: string;
  /** The consignment, pickup or drop and paper it was filed as (#135). */
  consignmentId?: string;
  legId?: string;
  documentTypeId?: string;
}

export interface Measure {
  qty: number;
  unit: Unit;
  ambientL?: number;
  tempC?: number;
  density?: number;
  vcf?: number;
  std20L?: number;
  certStd20L?: number;
  gross?: number;
  tare?: number;
  ticketNo?: string;
}
export interface Shortage {
  /** What its figures are in: for fuel, litres at 20 °C. */
  unit: Unit;
  loaded20L: number;
  delivered20L: number;
  lossL: number;
  allowancePct: number;
  allowanceL: number;
  netShortL: number;
  /** Charge per litre, in the base currency. */
  pricePerL: number;
  amountBase: number;
  status: "pending" | "charged" | "waived" | "none";
  decidedAt?: string;
  note?: string;
  /** May this person waive it? The company's shortage-waiver policy decides; charging needs the permission. */
  mayWaive?: boolean;
}
export interface Consignment {
  custom?: Record<string, unknown>;
  id: string;
  no: string;
  tripId: string;
  productId: string;
  invoiceNo: string;
  consignor: string;
  consignee: string;
  loadedAt: string;
  loadDocId?: string;
  load: Measure;
  delivered?: Measure & { at: string; podNo: string; docId?: string };
  shortage?: Shortage;
  writeOff?: { status: "pending" | "approved" | "rejected"; carrier: string; amountBase: number; reason?: string; requestedByName?: string; decidedAt?: string; note?: string };
}

export interface Expense {
  custom?: Record<string, unknown>;
  id: string;
  no: string;
  tripId?: string;
  driverId: string;
  categoryId: string;
  amount: number;
  currency: Currency;
  amountBase: number;
  receiptNo?: string;
  docId?: string;
  note?: string;
  status: "pending" | "approved" | "rejected";
  recordedBy: Role;
  waitingOn?: string;
  mayDecide?: boolean;
  movedUpFrom?: string;
  decidedAt?: string;
  reason?: string;
  at: string;
}

export interface Settlement {
  custom?: Record<string, unknown>;
  id: string;
  no: string;
  driverId: string;
  tripIds: string[];
  from: string;
  to: string;
  openingBase: number;
  advancesBase: number;
  expensesBase: number;
  shortagesBase: number;
  writeOffsBase: number;
  /** Positive: driver handed cash back. Negative: company paid the driver. */
  cashBase: number;
  closingBase: number;
  note?: string;
  postedAt: string;
}

export interface Nomination {
  custom?: Record<string, unknown>;
  id: string;
  version?: number;
  no: string;
  customerId: string;
  /** The order source's name. */
  source: string;
  orderSourceId?: string;
  reference?: string;
  loadingPlaceId: string;
  productId?: string;
  qtyPerTruck?: number;
  requiredDate: string;
  trucks: { truckId: string; driverId?: string }[];
  status: "draft" | "sent" | "accepted" | "converted" | "cancelled";
  note?: string;
  createdAt: string;
  sentAt?: string;
  acceptedAt?: string;
  tripIds: string[];
}

export type Nav = { masterId?: string; tripId?: string; view?: string; docId?: string; driverId?: string; masterEntity?: string };
export interface MsgButton {
  label: string;
  action?: Action;
  attach?: DocKind;
  nav?: Nav;
  tone?: "primary" | "danger";
}
export interface Message {
  id: string;
  thread: string;
  from: "bot" | "me" | "contact";
  text: string;
  title?: string;
  rows?: [string, string][];
  attachment?: Attachment;
  buttons?: MsgButton[];
  resolved?: string;
  refId?: string;
  at: string;
  /** The API thread when a desk shows it under its own name. */
  realThread?: string;
}
export interface ActivityEvent {
  id: string;
  at: string;
  tripId?: string;
  role: Role;
  text: string;
}

export interface AppData {
  /** How far back trips and settlements are loaded, and whether there's more. */
  history?: { from: string; older: boolean };
  version: 4;
  settings: Settings;
  places: Place[];
  customers: Customer[];
  drivers: Driver[];
  trucks: Truck[];
  trailers: Trailer[];
  pairings: Pairing[];
  routes: RouteTemplate[];
  products: Product[];
  categories: ExpenseCategory[];
  nominations: Nomination[];
  trips: Trip[];
  requests: FundRequest[];
  docs: DriverDoc[];
  consignments: Consignment[];
  /** Every consignment in the shape of #135, for the consignment screens. */
  cns: Cn[];
  expenses: Expense[];
  settlements: Settlement[];
  messages: Message[];
  events: ActivityEvent[];
  reads: Record<string, string>;
  /** Reference lists from the API that the screens choose from. */
  paymentMethods?: { id: string; name: string; kind: string; forFuel: boolean; forCash: boolean; referenceRequired: boolean }[];
  orderSources?: { id: string; name: string; referenceRequired: boolean }[];
  currencies?: { id: string; code: string; minorUnits: number }[];
  baseCurrency?: { id: string; code: string; minorUnits: number };
}

export type MasterEntity =
  | "places"
  | "customers"
  | "drivers"
  | "trucks"
  | "trailers"
  | "routes"
  | "products"
  | "categories";

export type Action =
  | {
      type: "nomination.save";
      custom?: Record<string, unknown>;
      id?: string;
      /** The version the edit started from, so a save over someone else's is refused. */
      version?: number;
      customerId: string;
      source: Nomination["source"];
      reference?: string;
      loadingPlaceId: string;
      productId?: string;
      qtyPerTruck?: number;
      requiredDate: string;
      trucks: { truckId: string; driverId?: string }[];
      note?: string;
    }
  | { type: "nomination.send"; id: string }
  | { type: "nomination.accept"; id: string }
  | { type: "nomination.convert"; id: string; routeId?: string; offloadPlaceId?: string }
  | { type: "nomination.cancel"; id: string }
  | {
      type: "trip.create";
      custom?: Record<string, unknown>;
      customerId: string;
      truckId: string;
      driverId?: string;
      trailerId?: string;
      routeId?: string;
      stops?: RouteStop[];
      plannedStart: string;
      productId?: string;
      plannedQty?: number;
      /** The trip's consignments (#135): `POST /trips` puts each on the route's loading and offloading stops. */
      consignments?: Record<string, unknown>[];
    }
  | {
      type: "trip.update";
      tripId: string;
      /** The version the edit started from, so a save over someone else's is refused. */
      version?: number;
      customerId?: string;
      driverId?: string;
      trailerId?: string;
      routeId?: string;
      stops?: RouteStop[];
      plannedStart?: string;
      productId?: string;
      plannedQty?: number;
      fuelBudgetL?: number;
      cashBudgetBase?: number;
    }
  | { type: "trip.cancel"; tripId: string; reason: string }
  | { type: "trip.stop"; tripId: string; reason: string; closingFuelL: number; placeId?: string }
  | { type: "trip.undelivered"; tripId: string; reasonId: string; note?: string; outcome: "return"; returnPlaceId?: string }
  | { type: "trip.undelivered"; tripId: string; reasonId: string; note?: string; outcome: "transfer"; vehicleId: string; driverId?: string; trailerId?: string; placeId?: string; closingFuelL: number }
  | { type: "trip.undelivered"; tripId: string; reasonId: string; note?: string; outcome: "write_off"; carrier?: string; insurerPartyId?: string; claimReference?: string; amount?: number; placeId?: string; closingFuelL: number }
  | { type: "writeoff.decide"; consignmentId: string; approve: boolean; note?: string; via?: "app" | "WhatsApp" }
  | { type: "request.create"; custom?: Record<string, unknown>; tripId: string; kind: "fuel" | "cash"; amount: number; currency: Currency; reason?: string }
  | { type: "request.decide"; custom?: Record<string, unknown>; id: string; approve: boolean; note?: string; via?: "app" | "WhatsApp" }
  | { type: "request.issue"; custom?: Record<string, unknown>; id: string; medium: string; reference: string; station?: string; via?: "app" | "WhatsApp" }
  | { type: "request.cancel"; id: string }
  | { type: "trip.dispatch"; custom?: Record<string, unknown>; tripId: string }
  | { type: "trip.ping"; tripId: string; km: number; speed: number; advanceMs?: number }
  | { type: "trip.arrive"; tripId: string; stopId: string }
  | { type: "trip.remind"; tripId: string }
  | {
      type: "doc.send";
      driverId: string;
      tripId?: string;
      kind: DocKind;
      note?: string;
      file?: Attachment;
      channel: DriverDoc["channel"];
      read?: Extracted;
    }
  | { type: "doc.return"; docId: string; reason: string }
  /** A message or photo from the driver that the office has dealt with. */
  | { type: "doc.done"; docId: string }
  | {
      type: "load.record";
      custom?: Record<string, unknown>;
      tripId: string;
      docId?: string;
      productId: string;
      invoiceNo: string;
      consignor: string;
      consignee: string;
      qty: number;
      ambientL?: number;
      tempC?: number;
      density?: number;
      certStd20L?: number;
      gross?: number;
      tare?: number;
      ticketNo?: string;
    }
  | {
      type: "delivery.record";
      custom?: Record<string, unknown>;
      consignmentId: string;
      docId?: string;
      podNo: string;
      qty: number;
      ambientL?: number;
      tempC?: number;
      density?: number;
      certStd20L?: number;
      gross?: number;
      tare?: number;
      ticketNo?: string;
    }
  | { type: "shortage.decide"; consignmentId: string; charge: boolean; note?: string; via?: "app" | "WhatsApp" }
  | {
      type: "expense.record";
      custom?: Record<string, unknown>;
      driverId: string;
      tripId?: string;
      categoryId: string;
      amount: number;
      currency: Currency;
      receiptNo?: string;
      docId?: string;
      note?: string;
    }
  | { type: "expense.decide"; custom?: Record<string, unknown>; id: string; approve: boolean; reason?: string; via?: "app" | "WhatsApp" }
  | { type: "trip.end"; custom?: Record<string, unknown>; tripId: string; closingFuelL: number }
  | { type: "settlement.request"; driverId: string }
  | { type: "settlement.post"; custom?: Record<string, unknown>; driverId: string; tripIds: string[]; cashBase: number; note?: string }
  | { type: "thread.read"; thread: string }
  | { type: "chat.send"; thread: string; text: string }
  | { type: "customer.reply"; nominationId: string };
