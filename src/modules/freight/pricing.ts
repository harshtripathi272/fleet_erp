import { ForbiddenError, NotFoundError } from '../../core/errors/index.js';
import type { Plain } from '../../core/masters/types.js';
import { Product } from '../cargo/models/product.model.js';
import { ProductGroup } from '../cargo/models/productGroup.model.js';
import { City } from '../geography/models/city.model.js';
import { Country } from '../geography/models/country.model.js';
import { Place } from '../geography/models/place.model.js';
import { Province } from '../geography/models/province.model.js';
import { Route } from '../geography/models/route.model.js';
import { Currency } from '../finance/models/currency.model.js';
import { rateBetween } from '../finance/finance.service.js';
import { billingSettings } from '../finance/settings.service.js';
import { Vehicle } from '../fleet/models/vehicle.model.js';
import { VehicleType } from '../fleet/models/vehicleType.model.js';
import { Party } from '../parties/models/party.model.js';
import { Consignment } from '../operations/models/cargo.model.js';
import { Trip } from '../operations/models/trip.model.js';
import { operationsSettings } from '../operations/settings.js';
import { conflict, log, need, refuse, save, type OpsContext } from '../operations/support.js';
import { chargeTypeByCode } from './defaults.js';
import { tariffFor, type Match, type MatchSubject } from './match.js';
import { ChargeType, ConsignmentType, FuelPrice, Tariff } from './models/freight.model.js';
import { priceConsignment, type ChargeTypeInput, type CurrencyUnits, type EngineSettings, type FactLeg, type FactLine, type PricingFacts, type RevenueResult, type TariffInput } from './revenue/index.js';
import { freightSettings } from './settings.js';

/**
 * The adapter between the database and the revenue engine (#135, consignments design 3.5.1): it gathers a
 * consignment's facts, finds its tariff, calls `priceConsignment` (#130) and saves what comes back on the
 * consignment. The engine is pure; everything that reads the database or the clock is here.
 */

const id = (v: unknown) => (v == null ? undefined : String(v));
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const day = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

async function units(currencyId: unknown): Promise<CurrencyUnits | null> {
  const c = await Currency.findById(currencyId).select('code minorUnits').lean<Plain>();
  return c ? { id: String(c._id), code: String(c.code), minorUnits: Number(c.minorUnits ?? 2) } : null;
}

/** The rate from one currency to another on a day, or null when none is recorded. */
async function rateOn(fromId: string, toId: string, on: Date): Promise<number | null> {
  if (fromId === toId) return 1;
  try { return (await rateBetween(fromId, toId, on)).rate; } catch (err) { if (err instanceof NotFoundError) return null; throw err; }
}

/** Minor units of one currency in another's, fractions kept: 31.00 ZMW a litre in USD cents. */
async function minorIn(minor: number, from: CurrencyUnits, to: CurrencyUnits, on: Date) {
  const rate = await rateOn(from.id, to.id, on);
  return rate == null ? undefined : minor * rate * 10 ** (to.minorUnits - from.minorUnits);
}

/** The day whose tariff and exchange rate apply (design 3.5.8): by the tariff's `priceOn`, else the company's. */
export function pricingDay(c: Plain, trip: Plain | null, priceOn: string): Date {
  const legs = (c.legs ?? []) as Plain[];
  const firstPickup = legs.filter((l) => l.kind === 'pickup' && l.recordedAt).map((l) => new Date(l.recordedAt as string)).sort((a, b) => +a - +b)[0];
  const lastDrop = legs.filter((l) => l.kind === 'drop' && l.recordedAt).map((l) => new Date(l.recordedAt as string)).sort((a, b) => +b - +a)[0];
  const booked = new Date((c.bookedAt ?? c.createdAt ?? Date.now()) as string);
  if (priceOn === 'booking_date') return booked;
  if (priceOn === 'trip_dispatch') return new Date((trip?.dispatchedAt ?? trip?.plannedStart ?? booked) as string);
  if (priceOn === 'delivery_date') return new Date((c.deliveredAt ?? lastDrop ?? c.loadedAt ?? firstPickup ?? booked) as string);
  return new Date((c.loadedAt ?? firstPickup ?? booked) as string);
}

/** A place's country, through its city and province. */
async function countryOf(placeId: unknown): Promise<Plain | null> {
  if (!placeId) return null;
  const place = await Place.findById(placeId).select('cityId code name').lean<Plain>();
  const city = place?.cityId ? await City.findById(place.cityId).select('provinceId').lean<Plain>() : null;
  const province = city?.provinceId ? await Province.findById(city.provinceId).select('countryId').lean<Plain>() : null;
  return province?.countryId ? Country.findById(province.countryId).select('code').lean<Plain>() : null;
}

/** The fuel price per litre for a trip on a day, in the base currency: the most specific fuel-price record, else the company's default. */
export async function fuelPriceFor(trip: Plain | null, on: Date): Promise<{ minor: number; currencyId: string; source: string } | null> {
  const vehicle = trip?.vehicleId ? await Vehicle.findById(trip.vehicleId).select('fuelTypeId').lean<Plain>() : null;
  const placeIds = ((trip?.stops ?? []) as Plain[]).map((s) => String(s.placeId));
  const countries = new Set<string>();
  for (const p of [...new Set(placeIds)].slice(0, 10)) { const c = await countryOf(p); if (c) countries.add(String(c._id)); }
  const rows = await FuelPrice.find({ status: 'active' }).lean<Plain[]>();
  const fits = rows.filter((r) => (!r.validFrom || new Date(r.validFrom as string) <= on) && (!r.validTo || new Date(r.validTo as string) >= day(on))
    && (!r.fuelTypeId || String(r.fuelTypeId) === String(vehicle?.fuelTypeId)) && (!r.placeId || placeIds.includes(String(r.placeId))) && (!r.countryId || countries.has(String(r.countryId))));
  const score = (r: Plain) => (r.placeId ? 4 : 0) + (r.countryId ? 2 : 0) + (r.fuelTypeId ? 1 : 0);
  const best = fits.sort((a, b) => score(b) - score(a) || +new Date((b.validFrom ?? 0) as string) - +new Date((a.validFrom ?? 0) as string))[0];
  if (best) return { minor: Number((best.pricePerL as Plain).amountMinor), currencyId: String((best.pricePerL as Plain).currencyId), source: String(best.name) };
  const settings = await freightSettings();
  const company = await (await import('../company/company.model.js')).Company.findOne().select('baseCurrencyId').lean<Plain>();
  if (settings.defaultFuelPricePerLMinor && company?.baseCurrencyId) return { minor: settings.defaultFuelPricePerLMinor, currencyId: String(company.baseCurrencyId), source: "the company's default" };
  return null;
}

/** km from the trip's first loading point to its last offloading point (today's "loaded km"). */
export function tripLoadedKm(trip: Plain | null) {
  const stops = (trip?.stops ?? []) as Array<{ kind: string; legKm: number }>;
  const first = stops.findIndex((s) => s.kind === 'load');
  const last = stops.map((s) => s.kind).lastIndexOf('offload');
  if (first < 0 || last <= first) return 0;
  return stops.slice(first + 1, last + 1).reduce((km, s) => km + Number(s.legKm ?? 0), 0);
}

/** What a tariff's conditions are compared with, for one consignment on its trip. */
export async function subjectOf(c: Plain, trip: Plain | null): Promise<MatchSubject> {
  const legs = ((c.legs ?? []) as Plain[]).filter((l) => l.status !== 'skipped');
  const from = legs.find((l) => l.kind === 'pickup')?.placeId;
  const to = legs.filter((l) => l.kind === 'drop' && l.placeId).at(-1)?.placeId;
  const productIds = [...new Set(((c.lines ?? []) as Plain[]).map((l) => String(l.productId)))];
  const groups = (await Product.find({ _id: { $in: productIds } }).select('groupId').lean<Plain[]>()).map((p) => id(p.groupId)).filter(Boolean) as string[];
  const vehicle = trip?.vehicleId ? await Vehicle.findById(trip.vehicleId).select('vehicleTypeId').lean<Plain>() : null;
  return {
    customerId: id(c.customerId), consignorPartyId: id(c.consignorPartyId), consignmentTypeId: id(c.consignmentTypeId), routeId: id(trip?.routeId),
    fromPlaceId: id(from), toPlaceId: id(to), fromCountryId: id((await countryOf(from))?._id), toCountryId: id((await countryOf(to))?._id),
    productIds, productGroupIds: [...new Set(groups)], vehicleTypeId: id(vehicle?.vehicleTypeId),
  };
}

/** A tariff record as the engine reads it. */
export function tariffInput(t: Plain, matchedOn?: string): TariffInput {
  return {
    ...(t as Plain), id: String(t._id), code: String(t.code), name: t.name as string, version: num(t.version), currencyId: String(t.currencyId),
    lines: ((t.lines ?? []) as Plain[]).map((l) => ({ ...(l as Plain), id: String(l._id), chargeTypeId: String(l.chargeTypeId),
      price: l.price ? { amountMinor: Number((l.price as Plain).amountMinor), currencyId: String((l.price as Plain).currencyId) } : undefined,
      minimum: l.minimum ? { amountMinor: Number((l.minimum as Plain).amountMinor), currencyId: String((l.minimum as Plain).currencyId) } : undefined,
      maximum: l.maximum ? { amountMinor: Number((l.maximum as Plain).amountMinor), currencyId: String((l.maximum as Plain).currencyId) } : undefined,
      slabs: (l.slabs as Plain[] | undefined)?.map((s) => ({ upTo: s.upTo as number | null | undefined, price: { amountMinor: Number((s.price as Plain).amountMinor), currencyId: String((s.price as Plain).currencyId) } })),
    })) as never,
    minimumCharge: t.minimumCharge ? { amountMinor: Number((t.minimumCharge as Plain).amountMinor), currencyId: String((t.minimumCharge as Plain).currencyId) } : undefined,
    matchedOn,
  };
}

/** Company → Freight and Money settings as the engine reads them, with the active charge types. */
export async function engineSettings(): Promise<EngineSettings> {
  const [settings, billing, types] = await Promise.all([freightSettings(), billingSettings(), ChargeType.find({ status: 'active' }).lean<Plain[]>()]);
  return {
    chargeOnDefault: settings.chargeOnDefault, distanceSourceDefault: settings.distanceSourceDefault, shortageDeductionDefault: settings.shortageDeductionDefault,
    tax: { mode: billing.taxMode, ratePercent: Number(billing.taxRatePercent ?? 0), pricesIncludeTax: Boolean(billing.pricesIncludeTax) },
    chargeTypes: types.map((t): ChargeTypeInput => ({
      id: String(t._id), code: String(t.code), name: String(t.name), kind: t.kind as ChargeTypeInput['kind'], direction: t.direction as ChargeTypeInput['direction'],
      taxable: t.taxable !== false, printLabel: t.printLabel as string | undefined, autoApply: Boolean(t.autoApply), defaultBasis: t.defaultBasis as never,
      defaultPrice: t.defaultPrice ? { amountMinor: Number((t.defaultPrice as Plain).amountMinor), currencyId: String((t.defaultPrice as Plain).currencyId) } : undefined,
      defaultPercent: num(t.defaultPercent),
    })),
  };
}

const plainMeasure = (m: Plain) => Object.fromEntries(Object.entries(m).filter(([k, v]) => v !== undefined && k !== 'docIds').map(([k, v]) => [k, k === 'lineId' ? String(v) : v]));

/**
 * Everything the engine needs about one consignment, in its currency: the lines with their products, the legs with
 * what was recorded, distances, the codes a condition may compare, the day's fuel price, and the revenue as saved.
 */
export async function factsFor(c: Plain, trip: Plain | null, currency: CurrencyUnits, on: Date): Promise<PricingFacts> {
  const base = await (async () => {
    const company = await (await import('../company/company.model.js')).Company.findOne().select('baseCurrencyId').lean<Plain>();
    const b = company?.baseCurrencyId ? await units(company.baseCurrencyId) : null;
    return b ? { ...b, rate: await rateOn(currency.id, b.id, on) } : undefined;
  })();
  const lines: FactLine[] = [];
  const ops = await operationsSettings();
  for (const line of (c.lines ?? []) as Plain[]) {
    const product = await Product.findById(line.productId).lean<Plain>();
    const unit = product?.unitId ? await (await import('../geography/models/unit.model.js')).Unit.findById(product.unitId).select('decimals').lean<Plain>() : null;
    const shortage = product?.shortagePricePerUnit as Plain | undefined;
    const from = shortage ? await units(shortage.currencyId) : null;
    const declared = line.declaredValue as Plain | undefined;
    const declaredFrom = declared ? await units(declared.currencyId) : null;
    lines.push({
      id: String(line._id), productId: String(line.productId), productName: product?.name as string, productCode: product?.code as string,
      plannedQty: num(line.plannedQty), unit: String(line.unit), pieces: num(line.pieces), grossKg: num(line.grossKg), volumeM3: num(line.volumeM3),
      declaredValueMinor: declared && declaredFrom ? await minorIn(Number(declared.amountMinor), declaredFrom, currency, on) : undefined,
      product: {
        volumeCorrected: Boolean(product?.volumeCorrected), densityKgPerL: num(product?.densityKgPerL), decimals: num(unit?.decimals),
        shortageAllowancePercent: num(product?.shortageAllowancePercent),
        shortagePricePerUnitMinor: shortage && from ? await minorIn(Number(shortage.amountMinor), from, currency, on) : undefined,
      },
    } as FactLine);
  }
  const placeName = new Map((await Place.find({ _id: { $in: ((c.legs ?? []) as Plain[]).map((l) => l.placeId).filter(Boolean) as never[] } }).select('name code').lean<Plain[]>()).map((p) => [String(p._id), p]));
  const legs: FactLeg[] = ((c.legs ?? []) as Plain[]).map((l) => ({
    id: String(l._id), kind: l.kind as FactLeg['kind'], status: l.status as FactLeg['status'], outcome: l.outcome as FactLeg['outcome'],
    placeName: l.placeId ? placeName.get(String(l.placeId))?.name as string : undefined,
    planned: (l.planned as Plain[] | undefined)?.map((p) => ({ lineId: String(p.lineId), qty: num(p.qty), pieces: num(p.pieces) })),
    actual: (l.actual as Plain[] | undefined)?.map((m) => plainMeasure(m)) as never,
  }));
  // A per-trip price is carried by the customer's first consignment on the trip.
  let perTrip: PricingFacts['perTrip'];
  if (trip) {
    const first = await Consignment.findOne({ tripId: trip._id, customerId: c.customerId, status: { $nin: ['cancelled', 'draft'] } }).sort({ bookedAt: 1, _id: 1 }).select('number').lean<Plain>();
    perTrip = { carries: !first || String(first._id) === String(c._id), carrierNumber: first && String(first._id) !== String(c._id) ? String(first.number) : undefined };
  }
  const subject = await subjectOf(c, trip);
  const code = async (model: { findById: (x: unknown) => { select: (f: string) => { lean: <T>() => Promise<T | null> } } }, v?: string) => (v ? ((await model.findById(v).select('code').lean<Plain>())?.code as string | undefined) : undefined);
  const firstProduct = await Product.findById((c.lines as Plain[])[0]?.productId).select('code groupId packaging').lean<Plain>();
  const legPlaces = ((c.legs ?? []) as Plain[]).filter((l) => l.status !== 'skipped');
  const fromPlace = placeName.get(String(legPlaces.find((l) => l.kind === 'pickup')?.placeId))?.code as string | undefined;
  const toPlace = placeName.get(String(legPlaces.filter((l) => l.kind === 'drop' && l.placeId).at(-1)?.placeId))?.code as string | undefined;
  const fuel = await fuelPriceFor(trip, on);
  const fuelUnits = fuel ? await units(fuel.currencyId) : null;
  const firstUp = legPlaces.filter((l) => l.kind === 'pickup' && l.recordedAt).map((l) => +new Date(l.recordedAt as string)).sort()[0];
  const lastDown = legPlaces.filter((l) => l.kind === 'drop' && l.recordedAt).map((l) => +new Date(l.recordedAt as string)).sort().at(-1);
  const custom = Object.fromEntries(Object.entries((c.custom ?? {}) as Plain).filter(([, v]) => ['number', 'string', 'boolean'].includes(typeof v) || v === null)) as PricingFacts['custom'];
  return {
    number: String(c.number), pricedOn: on, currency, base, lines, legs,
    distance: { leadKm: num(c.leadKm), tripLoadedKm: tripLoadedKm(trip) || undefined, manualKm: num((c.references as Plain | undefined)?.leadKm), tripKm: ((trip?.stops ?? []) as Plain[]).reduce((s, x) => s + Number(x.legKm ?? 0), 0) || undefined },
    perTrip, shortageAllowancePercent: ops.defaultShortageAllowancePercent,
    codes: {
      product: firstProduct?.code as string, productGroup: await code(ProductGroup as never, id(firstProduct?.groupId)), packaging: firstProduct?.packaging as string,
      type: await code(ConsignmentType as never, subject.consignmentTypeId), route: await code(Route as never, subject.routeId), vehicleType: await code(VehicleType as never, subject.vehicleTypeId),
      fromPlace, toPlace, fromCountry: await code(Country as never, subject.fromCountryId), toCountry: await code(Country as never, subject.toCountryId), paymentTerms: c.paymentTerms as string,
    },
    custom,
    fuelPrice: fuel && fuelUnits ? (fuelUnits.id === currency.id ? fuel.minor / 10 ** fuelUnits.minorUnits : (await minorIn(fuel.minor, fuelUnits, currency, on) ?? NaN) / 10 ** currency.minorUnits) : undefined,
    days: firstUp && lastDown && lastDown >= firstUp ? Math.round(((lastDown - firstUp) / 86_400_000) * 10) / 10 : undefined,
    previous: c.revenue ? { ...(c.revenue as Plain), status: (c.revenue as Plain).status as never, lines: (((c.revenue as Plain).lines ?? []) as Plain[]).map(plainLine) as never } : undefined,
  };
}

const plainLine = (l: Plain) => Object.fromEntries(Object.entries(l).filter(([, v]) => v !== undefined).map(([k, v]) => [k, ['chargeTypeId', 'tariffLineId', 'legId', 'lineId', 'by', '_id'].includes(k) ? String(v) : v]));

export interface Priced { result: RevenueResult; match: Match | null; facts: PricingFacts; tariff: TariffInput | null }

/** Works out a consignment's revenue without saving it. A tariff given (the editor's "Try it") is used instead of matching. */
export async function priceOf(c: Plain, options: { tariff?: Plain } = {}): Promise<Priced> {
  const trip = c.tripId ? await Trip.findById(c.tripId).lean<Plain>() : null;
  const settings = await freightSettings();
  const subject = await subjectOf(c, trip);
  // The day decides the tariff, and a tariff may say which day: start from the company's, then the tariff's own.
  let on = pricingDay(c, trip, settings.priceOnDefault);
  let match = options.tariff ? { tariff: options.tariff, score: 0, matchedOn: 'the tariff being tried' } : await tariffFor(subject, on);
  if (match?.tariff.priceOn && match.tariff.priceOn !== settings.priceOnDefault) {
    on = pricingDay(c, trip, String(match.tariff.priceOn));
    if (!options.tariff) match = (await tariffFor(subject, on)) ?? match;
  }
  const manual = (c.revenue as Plain | undefined)?.manual as Plain | undefined;
  const manualLine = (((c.revenue as Plain | undefined)?.lines ?? []) as Plain[]).find((l) => l.source === 'manual' && (l.kind === 'freight' || l.kind === 'minimum'));
  const currencyId = match?.tariff.currencyId ?? (manual ? (c.revenue as Plain).currencyId : undefined) ?? manualLine?.currencyId
    ?? (await Party.findById(c.customerId).select('currencyId').lean<Plain>())?.currencyId
    ?? (await (await import('../company/company.model.js')).Company.findOne().select('baseCurrencyId').lean<Plain>())?.baseCurrencyId;
  const currency = currencyId ? await units(currencyId) : null;
  if (!currency) throw refuse('Set the company base currency first (Company details).');
  const facts = await factsFor(c, trip, currency, on);
  const tariff = match ? tariffInput(match.tariff, match.matchedOn) : null;
  const result = priceConsignment(facts, tariff, await engineSettings());
  return { result, match, facts, tariff };
}

/** The revenue as saved on the consignment. */
function toRevenue(result: RevenueResult, previous: Plain | undefined) {
  return {
    status: result.status, tariffId: result.tariffId, tariffVersion: result.tariffVersion, currencyId: result.currencyId, pricedOn: result.pricedOn, pricedAt: new Date(),
    basis: result.basis, lines: result.lines, subtotalMinor: result.subtotalMinor, taxMinor: result.taxMinor, totalMinor: result.totalMinor,
    baseSubtotalMinor: result.baseSubtotalMinor, baseTotalMinor: result.baseTotalMinor, rateToBase: result.rateToBase, explanation: result.explanation, problem: result.problem,
    manual: previous?.manual, frozenAt: previous?.frozenAt, frozenFor: previous?.frozenFor, invoiceIds: previous?.invoiceIds,
  };
}

/**
 * Works a consignment's revenue out again and saves it (design 3.5.8): after it is made or changed, at every pickup
 * and drop, and when someone presses Reprice. A frozen or invoiced revenue is left as it is. Freezes on delivery when
 * Company → Freight says so. Two people repricing at once: the second save clashes and is retried.
 */
export async function reprice(cid: string, ctx?: OpsContext, options: { preview?: boolean } = {}) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const doc = await Consignment.findById(cid);
    if (!doc) throw new NotFoundError('Consignment not found');
    const c = doc.toObject() as Plain;
    if (['cancelled', 'draft'].includes(String(c.status))) return c.revenue as Plain | undefined;
    const priced = await priceOf(c);
    const before = c.revenue as Plain | undefined;
    if (priced.result.unchanged) return before;
    const revenue = toRevenue(priced.result, before);
    if (options.preview) return { before, after: revenue, changed: Number(before?.totalMinor ?? NaN) !== Number(revenue.totalMinor) || before?.status !== revenue.status } as Plain;
    const settings = await freightSettings();
    if (settings.freezeOn === 'delivery' && ['delivered', 'closed'].includes(String(c.status)) && revenue.status === 'priced') Object.assign(revenue, { status: 'frozen', frozenAt: new Date(), frozenFor: 'delivery' });
    doc.set('revenue', revenue);
    try {
      await doc.save();
      if (ctx && before?.status !== revenue.status && revenue.status === 'unpriced' && revenue.problem && before) await log(ctx, new Date(), `${c.number} is not priced: ${revenue.problem}`, { tripId: c.tripId, entity: 'consignments', entityId: c._id });
      return revenue as Plain;
    } catch (err) {
      if ((err as { name?: string }).name !== 'VersionError') throw err;
    }
  }
  throw conflict('This consignment is being changed by someone else. Try again.');
}

/* ---------- What a person does to a price ---------- */

const mayPrice = (ctx: OpsContext, action: 'update' | 'archive' = 'update') => {
  need(ctx, 'consignment-revenue', action);
  if (!ctx.can('consignment-revenue', 'sensitive')) throw new ForbiddenError('Your role does not see what consignments are worth.');
};

async function open(cid: string) {
  const doc = await Consignment.findById(cid);
  if (!doc) throw new NotFoundError('Consignment not found');
  const status = (doc.get('revenue') as Plain | undefined)?.status;
  if (status === 'invoiced') throw conflict('It is on an invoice; correct it with a credit note.');
  if (status === 'frozen') throw conflict('This price is frozen. Reopen it first.');
  return doc;
}

/** The revenue of one consignment, with the tariff that priced it. */
export async function getRevenue(cid: string) {
  const c = await Consignment.findById(cid).select('revenue number').lean<Plain>();
  if (!c) throw new NotFoundError('Consignment not found');
  const revenue = (c.revenue ?? { status: 'unpriced', lines: [], explanation: [] }) as Plain;
  const tariff = revenue.tariffId ? await Tariff.findById(revenue.tariffId).select('code name version').lean<Plain>() : null;
  return { ...revenue, lines: ((revenue.lines ?? []) as Plain[]).map(({ _id, ...l }) => ({ id: _id, ...l })), tariff: tariff ? { id: String(tariff._id), code: tariff.code, name: tariff.name, version: tariff.version, matchedOn: (revenue.explanation as string[] | undefined)?.[0] } : null };
}

/** "Set the price by hand": one freight line typed, with who and why; with `whole`, nothing else is added. */
export async function setManualPrice(cid: string, input: { amount: { amountMinor: number; currencyId: string }; reason?: string; whole?: boolean }, ctx: OpsContext) {
  mayPrice(ctx);
  const settings = await freightSettings();
  if (settings.manualPriceNeedsReason && !input.reason?.trim()) throw refuse('Say why the price is set by hand.');
  const doc = await open(cid);
  const freight = await chargeTypeByCode('FREIGHT');
  if (!freight) throw refuse('Switch the Freight charge type back on under Charge types first.');
  if (!(await units(input.amount.currencyId))) throw refuse('The currency was not found.');
  const revenue = ((doc.toObject() as Plain).revenue ?? {}) as Plain;
  const others = ((revenue.lines ?? []) as Plain[]).filter((l) => !(l.source === 'manual' && (l.kind === 'freight' || l.kind === 'minimum')));
  const line = { chargeTypeId: freight._id, kind: 'freight', description: 'Freight, priced by hand', qty: 1, unitPriceMinor: input.amount.amountMinor, amountMinor: input.amount.amountMinor, source: 'manual', accepted: true, note: input.reason, by: ctx.actorId };
  doc.set('revenue', { ...revenue, status: revenue.status ?? 'unpriced', currencyId: input.amount.currencyId, lines: [...others, line], manual: { by: ctx.actorId, at: new Date(), reason: input.reason, whole: Boolean(input.whole) } });
  await save(doc);
  await reprice(cid, ctx);
  await log(ctx, new Date(), `${doc.get('number')} priced by hand${input.reason ? `: ${input.reason}` : ''}`, { tripId: doc.get('tripId'), entity: 'consignments', entityId: doc._id });
  return getRevenue(cid);
}

/** "Add a charge": a line of any charge type, typed by a person; it survives every reprice. */
export async function addChargeLine(cid: string, input: { chargeTypeId: string; description?: string; qty?: number; unitPrice: { amountMinor: number; currencyId: string }; note?: string }, ctx: OpsContext) {
  mayPrice(ctx);
  const doc = await open(cid);
  const type = await ChargeType.findOne({ _id: input.chargeTypeId, status: 'active' }).lean<Plain>();
  if (!type) throw refuse('Choose a charge type that is switched on.');
  const revenue = ((doc.toObject() as Plain).revenue ?? { status: 'unpriced', lines: [] }) as Plain;
  if (revenue.currencyId && String(revenue.currencyId) !== input.unitPrice.currencyId) throw refuse("Use the consignment's price currency.");
  const qty = input.qty ?? 1;
  const sign = type.kind === 'deduction' ? -1 : 1;
  const line = { chargeTypeId: type._id, kind: type.kind, description: input.description ?? String(type.printLabel ?? type.name), qty, unitPriceMinor: sign * Math.abs(input.unitPrice.amountMinor), amountMinor: Math.round(sign * Math.abs(input.unitPrice.amountMinor) * qty), source: 'manual', accepted: true, note: input.note, by: ctx.actorId };
  doc.set('revenue', { ...revenue, currencyId: revenue.currencyId ?? input.unitPrice.currencyId, lines: [...((revenue.lines ?? []) as Plain[]), line] });
  await save(doc);
  await reprice(cid, ctx);
  await log(ctx, new Date(), `${line.description} added to ${doc.get('number')}`, { tripId: doc.get('tripId'), entity: 'consignments', entityId: doc._id });
  return getRevenue(cid);
}

/** Switches an automatic or added line on or off. A line switched off stays off through every reprice. */
export async function setLineAccepted(cid: string, lineId: string, accepted: boolean, ctx: OpsContext) {
  mayPrice(ctx);
  const doc = await open(cid);
  const lines = (((doc.toObject() as Plain).revenue as Plain | undefined)?.lines ?? []) as Plain[];
  const line = lines.find((l) => String(l._id) === lineId);
  if (!line) throw new NotFoundError('Line not found');
  if (line.source === 'tariff') throw refuse('Only an automatic or added line can be switched off.');
  if (line.source === 'manual' && !accepted && (line.kind === 'freight' || line.kind === 'minimum')) throw refuse('Remove a hand-set price by pricing it again by hand, or reopen it to the tariff.');
  line.accepted = accepted;
  doc.set('revenue.lines', lines);
  await save(doc);
  await reprice(cid, ctx);
  return getRevenue(cid);
}

/** Fixes the price: nothing reprices it until someone reopens it. Billing freezes on drafting an invoice. */
export async function freeze(cid: string, ctx: OpsContext | null, why: 'invoice' | 'settlement' | 'delivery' | 'manual' = 'manual') {
  if (ctx) mayPrice(ctx);
  const doc = await Consignment.findById(cid);
  if (!doc) throw new NotFoundError('Consignment not found');
  const revenue = doc.get('revenue') as Plain | undefined;
  if (revenue?.status === 'frozen' || revenue?.status === 'invoiced') return getRevenue(cid);
  if (!revenue || revenue.status === 'unpriced') throw refuse(`${doc.get('number')} has no price to freeze.`);
  doc.set({ 'revenue.status': 'frozen', 'revenue.frozenAt': new Date(), 'revenue.frozenFor': why });
  await save(doc);
  if (ctx) await log(ctx, new Date(), `${doc.get('number')}: price frozen`, { tripId: doc.get('tripId'), entity: 'consignments', entityId: doc._id });
  return getRevenue(cid);
}

/** "Reopen pricing", with a reason: refused once it is on an invoice. Needs the area's Manage level. */
export async function reopen(cid: string, reason: string, ctx: OpsContext) {
  mayPrice(ctx, 'archive');
  const doc = await Consignment.findById(cid);
  if (!doc) throw new NotFoundError('Consignment not found');
  const revenue = doc.get('revenue') as Plain | undefined;
  if (revenue?.status === 'invoiced') throw conflict('It is on an invoice; correct it with a credit note.');
  if (revenue?.status !== 'frozen') throw conflict('This price is not frozen.');
  doc.set({ 'revenue.status': 'estimated', 'revenue.frozenAt': undefined, 'revenue.frozenFor': undefined });
  await save(doc);
  await reprice(cid, ctx);
  await log(ctx, new Date(), `${doc.get('number')}: pricing reopened: ${reason}`, { tripId: doc.get('tripId'), entity: 'consignments', entityId: doc._id });
  return getRevenue(cid);
}

/** Billing marks the consignments it put on an approved invoice (design 3.5.9). */
export async function markInvoiced(consignmentIds: unknown[], invoiceId: unknown) {
  if (!consignmentIds.length) return;
  await Consignment.updateMany({ _id: { $in: consignmentIds } }, { $set: { 'revenue.status': 'invoiced' }, $addToSet: { 'revenue.invoiceIds': invoiceId }, $inc: { version: 1 } });
}
