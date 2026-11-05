import type {
  ActivityEvent, AppData, Consignment, Customer, Decision, Driver, DriverDoc, Expense, ExpenseCategory, FundRequest, Message, MsgButton,
  Nomination, Pairing, Place, Product, RouteTemplate, Settlement, Trailer, Trip, Truck, Unit,
} from "../domain/types";
import { setBaseCurrencyCode } from "../ui/format";

/**
 * Maps API records onto the shape the desks were built against (`AppData` from the trip-flow mock), so
 * every screen keeps working while the records live in MongoDB. Masters are richer than the mock's:
 * vehicles are trucks, parties with the customer role are customers, money is minor units with a currency.
 */

// API records are plain JSON; the adapter reads the fields it needs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Rec = Record<string, any>;

/** Masters and reference lists, loaded once and refreshed after master edits. */
export interface Reference {
  me: { id: string; name: string; roles: string[]; permissions: { resource: string; actions: string[] }[] };
  company: Rec | null;
  currencies: Rec[];
  rates: Rec[];
  countries: Rec[];
  cities: Rec[];
  places: Rec[];
  borderPosts: Rec[];
  routes: Rec[];
  tripBudgets: Rec[];
  parties: Rec[];
  orderSources: Rec[];
  vehicles: Rec[];
  vehicleModels: Rec[];
  fuelNorms: Rec[];
  trailers: Rec[];
  trailerTypes: Rec[];
  pairings: Rec[];
  drivers: Rec[];
  branches: Rec[];
  products: Rec[];
  units: Rec[];
  categories: Rec[];
  paymentMethods: Rec[];
}

/** Trip-side records from `/operations/sync`, merged by id. */
export interface Operations {
  trips: Rec[];
  requests: Rec[];
  documents: Rec[];
  consignments: Rec[];
  expenses: Rec[];
  settlements: Rec[];
  nominations: Rec[];
  vehicleStates: Rec[];
  driverAccounts: Rec[];
  messages: Rec[];
  activity: Rec[];
  reads: { thread: string; at: string }[];
}

const index = (rows: Rec[]) => new Map(rows.map((r) => [String(r.id), r]));

/** The same rule as the API: the waiting level or any later one in the policy, or the fallback permission without a policy. */
function mayDecide(me: Reference["me"], approval?: Rec) {
  if (!approval?.levels?.length) return undefined;
  const can = (resource: string) => me.permissions.some((p) => (p.resource === "*" || p.resource === resource) && (p.actions.includes("*") || p.actions.includes("create")));
  return (approval.levels as Rec[]).slice(approval.current ?? 0).some((l) =>
    l.fallbackResource ? can(l.fallbackResource) : l.approverUserId ? l.approverUserId === me.id : me.roles.includes(l.approverRoleKey));
}
/** Taking the final decision at once, as waiving a shortage does: the policy's last level decides. */
function mayDecideFinal(me: Reference["me"], approval?: Rec) {
  const last = (approval?.levels as Rec[] | undefined)?.at(-1);
  if (!last) return undefined;
  return mayDecide(me, { levels: [last], current: 0 });
}
const waitingLabel = (approval?: Rec) => approval?.levels?.[approval.current ?? 0]?.label as string | undefined;
const movedUpFrom = (approval?: Rec) => (approval?.levels as Rec[] | undefined)?.filter((l) => l.escalatedAt).at(-1)?.label as string | undefined;
const positive = (...values: unknown[]) => values.find((v): v is number => typeof v === "number" && v > 0);
const via = (v?: string): Decision["via"] => (v === "whatsapp" ? "WhatsApp" : "app");
const CHANNEL: Record<string, DriverDoc["channel"]> = { whatsapp: "WhatsApp", app: "App", operations: "Operations" };
const DEPOT_TYPES = new Set(["depot", "terminal", "refinery", "port", "fuel_station", "yard", "mine"]);

export function toAppData(ref: Reference, ops: Operations): AppData {
  const currencies = index(ref.currencies);
  const base = currencies.get(String(ref.company?.baseCurrencyId)) ?? ref.currencies.find((c) => c.code === "ZMW") ?? { id: "", code: "ZMW", minorUnits: 2 };
  setBaseCurrencyCode(base.code);
  const baseUnits = 10 ** Number(base.minorUnits ?? 2);
  const toMajor = (minor: number | undefined, currencyId?: string) => (minor ?? 0) / 10 ** Number(currencies.get(String(currencyId ?? base.id))?.minorUnits ?? 2);
  const baseMajor = (minor: number | undefined) => (minor ?? 0) / baseUnits;
  const codeOf = (currencyId?: string) => String(currencies.get(String(currencyId))?.code ?? base.code);
  const latestRate = (from: string, to: string) => ref.rates.filter((r) => r.baseCurrencyId === from && r.quoteCurrencyId === to && r.status === "active").sort((a, b) => String(b.effectiveDate).localeCompare(String(a.effectiveDate)))[0]?.rate as number | undefined;
  /** Base units for one unit of a currency, from the exchange-rates master (either direction); none when no rate exists. */
  const rateToBase = (currencyId: string) => {
    if (currencyId === base.id) return 1;
    const direct = latestRate(currencyId, base.id);
    if (direct) return direct;
    const inverse = latestRate(base.id, currencyId);
    return inverse ? 1 / inverse : undefined;
  };
  const fx: Record<string, number> = Object.fromEntries(ref.currencies.flatMap((c) => { const rate = rateToBase(String(c.id)); return rate ? [[String(c.code), rate]] : []; }));
  /** Base-currency amount of a money value; NaN (shown as "—") when there is no rate, rather than a guess. */
  const inBase = (money?: Rec) => {
    if (!money) return 0;
    const major = toMajor(money.amountMinor, money.currencyId);
    const rate = rateToBase(String(money.currencyId ?? base.id));
    return rate ? major * rate : Number.NaN;
  };

  const cities = index(ref.cities);
  const countries = index(ref.countries);
  const waits = new Map(ref.borderPosts.map((b) => [String(b.placeId), Number(b.typicalWaitHours ?? 0)]));
  const places: Place[] = ref.places.map((p) => {
    const city = cities.get(String(p.cityId ?? p.address?.cityId));
    return {
      id: p.id, name: p.name, country: String(countries.get(String(city?.countryId))?.name ?? ""),
      lat: p.location?.lat ?? 0, lng: p.location?.lng ?? 0,
      kind: p.type === "border" ? "border" : DEPOT_TYPES.has(p.type) ? "depot" : "city",
      haltHours: p.type === "border" ? waits.get(p.id) ?? 0 : 0,
    };
  });

  const customers: Customer[] = ref.parties.filter((p) => (p.roles ?? []).includes("customer")).map((p) => {
    const contact = (p.contacts ?? []).find((c: Rec) => c.isPrimary) ?? p.contacts?.[0];
    return { id: p.id, name: p.name, contact: contact?.name ?? "", phone: contact?.whatsapp ?? contact?.phone ?? "" };
  });

  const accounts = new Map(ops.driverAccounts.map((a) => [String(a.driverId), a]));
  const drivers: Driver[] = ref.drivers.filter((d) => d.status === "active").map((d) => {
    const account = accounts.get(d.id);
    return {
      id: d.id, name: d.name, phone: d.whatsapp ?? d.phone ?? "", licence: d.licence?.number ?? "",
      openingBalanceZmw: inBase(d.openingBalance),
      settleRequestedAt: account?.settleRequestedAt, settleRequestedBy: account?.settleRequestedByDesk,
    };
  });

  const models = index(ref.vehicleModels);
  const states = new Map(ops.vehicleStates.map((s) => [String(s.vehicleId), s]));
  const branches = index(ref.branches);
  const trucks: Truck[] = ref.vehicles.filter((v) => v.status === "active").map((v) => {
    const model = models.get(String(v.modelId));
    const norm = ref.fuelNorms.find((n) => n.status === "active" && v.modelId && n.vehicleModelId === v.modelId) ?? ref.fuelNorms.find((n) => n.status === "active" && n.vehicleTypeId === v.vehicleTypeId);
    const state = states.get(v.id);
    return {
      id: v.id, plate: v.registrationNumber, model: model?.name ?? "",
      placeId: state?.placeId ?? branches.get(String(v.homeBranchId))?.placeId ?? "",
      fuelL: Number(state?.fuelL ?? 0),
      tankL: positive(v.tankCapacityL, model?.tankCapacityL) ?? 0,
      emptyKmpl: positive(v.kmPerLEmpty, model?.kmPerLEmpty, norm?.kmPerLEmpty) ?? 0,
      loadedKmpl: positive(v.kmPerLLoaded, model?.kmPerLLoaded, norm?.kmPerLLoaded) ?? 0,
      capacityT: positive(v.payloadKg) ? v.payloadKg / 1000 : 30,
      driverId: ref.drivers.find((d) => d.status === "active" && d.assignedVehicleId === v.id)?.id,
      trailerId: v.currentTrailerId,
    };
  });

  const trailerTypes = index(ref.trailerTypes);
  const trailers: Trailer[] = ref.trailers.filter((t) => t.status === "active").map((t) => ({
    id: t.id, plate: t.registrationNumber, type: trailerTypes.get(String(t.trailerTypeId))?.name ?? "Trailer",
    capacity: positive(t.capacityL) ?? (positive(t.capacityKg) ?? 0) / 1000, unit: positive(t.capacityL) ? "L" : "t",
  }));
  const pairings: Pairing[] = ref.pairings.map((p) => ({ id: p.id, truckId: p.vehicleId, trailerId: p.trailerId, from: p.from, to: p.to }));

  const routes: RouteTemplate[] = ref.routes.filter((r) => r.status === "active").map((r) => {
    const budget = ref.tripBudgets.find((b) => b.routeId === r.id && b.status === "active");
    return {
      id: r.id, name: r.name,
      stops: (r.stops ?? []).map((s: Rec) => ({ placeId: s.placeId, kind: s.kind })),
      legKm: (r.stops ?? []).map((s: Rec) => Number(s.legKm ?? 0)),
      cashBudgetZmw: r.cashBudget ? inBase(r.cashBudget) : budget?.totalCashMinor ? inBase({ amountMinor: budget.totalCashMinor, currencyId: budget.currencyId }) : 0,
      fuelBudgetL: r.fuelBudgetL ?? budget?.fuelL,
    };
  });

  const units = index(ref.units);
  const products: Product[] = ref.products.filter((p) => p.status === "active").map((p) => {
    const symbol = String(units.get(String(p.unitId))?.symbol ?? units.get(String(p.unitId))?.code ?? "t");
    const price = p.shortagePricePerUnit as Rec | undefined;
    return {
      id: p.id, name: p.name, kind: p.volumeCorrected ? "fuel" : "general",
      measure: p.volumeCorrected ? "volume" : units.get(String(p.unitId))?.dimension === "mass" ? "weighed" : "counted",
      unit: p.volumeCorrected ? "L" : symbol,
      decimals: Number(units.get(String(p.unitId))?.decimals ?? 2),
      shortagePct: p.shortageAllowancePercent,
      shortagePricePerL: price ? inBase(price) : undefined,
    };
  });
  const categories: ExpenseCategory[] = ref.categories.filter((c) => c.status === "active").map((c) => ({ id: c.id, name: c.name }));

  /* ---------- Trip-side records ---------- */

  const trips: Trip[] = ops.trips.map((t) => ({
    id: t.id, version: t.version, no: t.number, nominationId: t.nominationId, customerId: t.customerId, truckId: t.vehicleId,
    driverId: t.driverId, trailerId: t.trailerId, routeId: t.routeId,
    stops: (t.stops ?? []).map((s: Rec) => ({ id: String(s.id ?? s._id), placeId: s.placeId, kind: s.kind, legKm: s.legKm, legHours: s.legHours, arrivedAt: s.arrivedAt, arrivedVia: s.arrivedVia, leftAt: s.leftAt })),
    productId: t.productId, plannedQty: t.plannedQty, plannedStart: t.plannedStart,
    fuelBudgetL: t.fuelBudgetL ?? 0, cashBudgetZmw: baseMajor(t.cashBudget?.amountMinor), openingFuelL: t.openingFuelL ?? 0,
    createdAt: t.createdAt, dispatchedAt: t.dispatchedAt, endedAt: t.endedAt, closingFuelL: t.closingFuelL, stopReason: t.stopReason, custom: t.custom, undelivered: t.undelivered, transferredToTripId: t.transferredToTripId, transferredFromTripId: t.transferredFromTripId, cancelledAt: t.cancelledAt, settleAfterCancel: t.settleAfterCancel,
    tracking: t.tracking ? { km: t.tracking.km ?? 0, speed: t.tracking.speed ?? 0, heading: t.tracking.heading ?? 0, at: t.tracking.at, source: t.tracking.source } : undefined,
    settlementId: t.settlementId,
    stages: (t.stages ?? []).map((s: Rec) => ({ code: s.code, name: s.name, completesOn: s.completesOn, completedAt: s.completedAt })),
    stage: t.stage ?? null,
  })).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const requests: FundRequest[] = ops.requests.map((r) => ({
    id: r.id, no: r.number, tripId: r.tripId, kind: r.kind,
    amount: r.kind === "fuel" ? r.litres : toMajor(r.amount?.amountMinor, r.amount?.currencyId),
    currency: r.kind === "fuel" ? base.code : codeOf(r.amount?.currencyId),
    suggested: r.kind === "fuel" ? r.suggested : baseMajor(r.suggested),
    reason: r.reason,
    // A request past its first approval level shows as the mock's second ("owner") step.
    custom: r.custom,
    status: r.status === "pending" && (r.approval?.current ?? 0) > 0 ? "owner" : r.status,
    waitingOn: r.status === "pending" ? waitingLabel(r.approval) : undefined,
    mayDecide: r.status === "pending" ? mayDecide(ref.me, r.approval) : undefined,
    movedUpFrom: r.status === "pending" ? movedUpFrom(r.approval) : undefined,
    level: r.approval?.levels?.length > 1 ? { current: (r.approval.current ?? 0) + 1, of: r.approval.levels.length } : undefined,
    trail: (r.trail ?? []).map((d: Rec) => ({ role: d.desk === "viewer" ? "operations" : d.desk, what: d.what, at: d.at, note: d.note, via: via(d.via) })),
    medium: r.medium, reference: r.reference, station: r.station, issuedAt: r.issuedAt,
    fxAtIssue: r.kind === "cash" && r.rate && r.rate !== 1 ? r.rate : undefined, createdAt: r.createdAt,
  })).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const docs: DriverDoc[] = ops.documents.map((d) => ({
    id: d.id, tripId: d.tripId, driverId: d.driverId, kind: d.kind, channel: CHANNEL[d.channel] ?? "Operations", note: d.note,
    file: d.file ? { name: d.file.name, mime: d.file.mime, fileId: d.file.fileId, sampleId: d.file.sampleId, dataUrl: d.file.dataUrl } : undefined,
    read: d.reading ? { ...d.reading, currency: d.reading.currencyCode } : undefined,
    simulated: Boolean(d.simulated),
    status: d.status, recordRef: d.recordRef, returnReason: d.returnReason, at: d.at,
  })).sort((a, b) => a.at.localeCompare(b.at));

  const consignments: Consignment[] = ops.consignments.map((c) => ({
    id: c.id, no: c.number, tripId: c.tripId, productId: c.productId, invoiceNo: c.invoiceNo, consignor: c.consignor ?? "—", consignee: c.consignee ?? "",
    custom: c.custom,
    loadedAt: c.loadedAt, loadDocId: c.loadDocId, load: c.load,
    delivered: c.delivered ? { ...c.delivered, at: c.delivered.at, podNo: c.delivered.podNo, docId: c.delivered.docId } : undefined,
    shortage: c.shortage ? {
      unit: c.shortage.unit ?? "L",
      loaded20L: c.shortage.loaded20L, delivered20L: c.shortage.delivered20L, lossL: c.shortage.lossL, allowancePct: c.shortage.allowancePercent,
      allowanceL: c.shortage.allowanceL, netShortL: c.shortage.netShortL,
      pricePerL: c.shortage.pricePerL ? Math.round(inBase(c.shortage.pricePerL) * 100) / 100 : 0,
      amountZmw: baseMajor(c.shortage.baseAmountMinor), status: c.shortage.status, decidedAt: c.shortage.decidedAt, note: c.shortage.note,
      mayWaive: c.shortage.status === "pending" ? mayDecideFinal(ref.me, c.shortage.approval) : undefined,
    } : undefined,
    writeOff: c.writeOff ? {
      status: c.writeOff.status, carrier: c.writeOff.carrier, amountZmw: baseMajor(c.writeOff.baseAmountMinor), reason: c.writeOff.reason,
      requestedByName: c.writeOff.requestedByName, decidedAt: c.writeOff.decidedAt, note: c.writeOff.note,
    } : undefined,
  })).sort((a, b) => a.loadedAt.localeCompare(b.loadedAt));

  const expenses: Expense[] = ops.expenses.map((e) => ({
    custom: e.custom,
    id: e.id, no: e.number, tripId: e.tripId, driverId: e.driverId, categoryId: e.categoryId,
    amount: toMajor(e.amount?.amountMinor, e.amount?.currencyId), currency: codeOf(e.amount?.currencyId), amountZmw: baseMajor(e.baseAmountMinor),
    receiptNo: e.receiptNo, docId: e.docId, note: e.note, status: e.status,
    waitingOn: e.status === "pending" ? waitingLabel(e.approval) : undefined, mayDecide: e.status === "pending" ? mayDecide(ref.me, e.approval) : undefined,
    movedUpFrom: e.status === "pending" ? movedUpFrom(e.approval) : undefined,
    recordedBy: e.recordedByDesk === "viewer" ? "operations" : e.recordedByDesk,
    decidedAt: e.decidedAt, reason: e.reason, at: e.at,
  })).sort((a, b) => a.at.localeCompare(b.at));

  const settlements: Settlement[] = ops.settlements.map((s) => ({
    id: s.id, no: s.number, driverId: s.driverId, tripIds: s.tripIds, from: s.from, to: s.to,
    openingZmw: baseMajor(s.openingMinor), advancesZmw: baseMajor(s.advancesMinor), expensesZmw: baseMajor(s.expensesMinor),
    custom: s.custom, shortagesZmw: baseMajor(s.shortagesMinor), writeOffsZmw: baseMajor(s.writeOffsMinor ?? 0), cashZmw: baseMajor(s.cashMinor), closingZmw: baseMajor(s.closingMinor), note: s.note, postedAt: s.postedAt,
  })).sort((a, b) => a.postedAt.localeCompare(b.postedAt));

  const sources = index(ref.orderSources);
  const nominations: Nomination[] = ops.nominations.map((n) => ({
    custom: n.custom,
    id: n.id, version: n.version, no: n.number, customerId: n.customerId, source: sources.get(String(n.orderSourceId))?.name ?? "Direct", orderSourceId: n.orderSourceId,
    reference: n.reference, loadingPlaceId: n.loadingPlaceId, productId: n.productId, qtyPerTruck: n.qtyPerTruck,
    requiredDate: String(n.requiredDate).slice(0, 10), trucks: (n.trucks ?? []).map((t: Rec) => ({ truckId: t.vehicleId, driverId: t.driverId })),
    status: n.status, note: n.note, createdAt: n.createdAt, sentAt: n.sentAt, acceptedAt: n.acceptedAt, tripIds: n.tripIds ?? [],
  })).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const button = (b: Rec): MsgButton => ({ ...b, action: b.action ? { ...b.action, ...(b.action.via ? { via: via(b.action.via) } : {}) } : undefined }) as MsgButton;
  const messages: Message[] = ops.messages.map((m) => ({
    id: m.id, thread: m.thread, from: m.from, text: m.text ?? "", title: m.title, rows: m.rows, attachment: m.attachment,
    buttons: m.buttons?.map(button), resolved: m.resolved, refId: m.refId, at: m.at,
  })).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const events: ActivityEvent[] = ops.activity.map((e) => ({ id: e.id, at: e.at, tripId: e.tripId, role: e.desk === "viewer" ? "operations" : e.desk, text: e.text }))
    .sort((a, b) => a.at.localeCompare(b.at));

  const hq = ref.branches.find((b) => b.type === "head_office");
  const desks = ref.me.roles;
  const named = (desk: string, fallback: string) => (desks.includes(desk) || (desk === "owner" && desks.includes("admin")) ? ref.me.name : fallback);
  return {
    version: 4,
    settings: {
      company: ref.company?.brand?.productName ?? ref.company?.tradingName ?? ref.company?.legalName ?? "",
      office: hq?.name ?? "",
      officeAddress: hq?.address
        ? [hq.address.line1, hq.address.line2, cities.get(String(hq.address.cityId))?.name].filter(Boolean).join(", ")
        : undefined,
      fx,
      roadDistanceFactor: Number(ref.company?.operations?.roadDistanceFactor ?? 1.28),
      averageSpeedKmh: Number(ref.company?.operations?.averageSpeedKmh ?? 62),
      stopBeforeLoading: ref.company?.operations?.stopBeforeLoading !== false,
      cargoKinds: ref.company?.operations?.cargoKinds ?? ["volume", "weighed", "counted"],
      loadedTripOutcomes: ref.company?.operations?.loadedTripOutcomes ?? ["return", "transfer", "write_off"],
      writeOffCarriers: ref.company?.operations?.writeOffCarriers ?? ["driver", "company", "insurance"],
      writeOffDefaultCarrier: ref.company?.operations?.writeOffDefaultCarrier ?? "company",
      loadedTripRoles: ref.company?.operations?.loadedTripRoles ?? ["operations"],
      writeOffNeedsOwner: ref.company?.operations?.writeOffNeedsOwner !== false,
      clockOffsetMs: 0,
      seq: {},
      people: { owner: named("owner", "Owner"), operations: named("operations", "Operations"), finance: named("finance", "Finance") },
    },
    places, customers, drivers, trucks, trailers, pairings, routes, products, categories,
    nominations, trips, requests, docs, consignments, expenses, settlements, messages, events,
    reads: Object.fromEntries(ops.reads.map((r) => [r.thread, r.at])),
    paymentMethods: ref.paymentMethods.filter((m) => m.status === "active").map((m) => ({ id: m.id, name: m.name, kind: m.kind, forFuel: Boolean(m.forFuel), forCash: m.forCash !== false, referenceRequired: m.referenceRequired !== false })),
    orderSources: ref.orderSources.filter((o) => o.status === "active").map((o) => ({ id: o.id, name: o.name, referenceRequired: Boolean(o.referenceRequired) })),
    currencies: ref.currencies.filter((c) => c.status === "active").map((c) => ({ id: c.id, code: c.code, minorUnits: Number(c.minorUnits ?? 2) })),
    baseCurrency: { id: base.id, code: base.code, minorUnits: Number(base.minorUnits ?? 2) },
  };
}

const WORK = /^(queue|role|user):/;

/**
 * A desk's phone shows every work thread the person sees (the API sends only those their permissions
 * allow) under the desk's name; contact threads stay as they are.
 */
export function forDesk(data: AppData, desk: string): AppData {
  const workReads = Object.entries(data.reads).filter(([thread]) => WORK.test(thread)).map(([, at]) => at);
  return {
    ...data,
    messages: data.messages.map((m) => (WORK.test(m.thread) ? { ...m, thread: desk, realThread: m.thread } : m)),
    reads: { ...data.reads, [desk]: workReads.sort().at(-1) ?? "" },
  };
}
