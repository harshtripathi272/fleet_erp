import { Types } from 'mongoose';
import { z } from 'zod';
import { NotFoundError } from '../../core/errors/index.js';
import { money, objectId, text } from '../../core/masters/zod.js';
import type { Plain } from '../../core/masters/types.js';
import { Consignment } from '../operations/models/cargo.model.js';
import { Trip } from '../operations/models/trip.model.js';
import { refuse, type OpsContext } from '../operations/support.js';
import { BASIS_LABELS, BASIS_SENTENCES } from './freight.masters.js';
import { createTariffSchema } from './freight.schema.js';
import { matchTariff } from './match.js';
import { RATE_BASES, Tariff } from './models/freight.model.js';
import { engineSettings, priceOf, subjectOf, tariffInput, pricingDay } from './pricing.js';
import { checkTariff, FORMULA_VARIABLES, priceConsignment, type PricingFacts } from './revenue/index.js';
import { freightSettings } from './settings.js';
import { Currency } from '../finance/models/currency.model.js';

/**
 * The freight routes that are not plain masters (#135, design 3.12): the tariff editor's "Try it" and its
 * reference of formula values, and why a tariff did or did not apply to a consignment.
 */

const PRICE_INPUT: Record<string, 'price' | 'percent' | 'formula' | 'none'> = {
  percent_of_freight: 'percent', percent_of_value: 'percent', formula: 'formula',
  shortage_beyond_allowance: 'price', damage_value: 'price',
};

/** The formula values and, for each basis, its words and which inputs a line of it shows. */
export function formulaReference() {
  return {
    variables: FORMULA_VARIABLES,
    bases: RATE_BASES.map((value) => ({
      value, label: BASIS_LABELS[value], sentence: BASIS_SENTENCES[value], price: PRICE_INPUT[value] ?? 'price',
      /** Shortage and damage fall back to the product's shortage price, so their price may be left empty. */
      priceOptional: value === 'shortage_beyond_allowance' || value === 'damage_value',
      free: value === 'per_drop_beyond' || value === 'per_pickup_beyond',
    })),
  };
}

const sample = z.strictObject({
  productId: objectId.optional(),
  unit: text(20).optional(),
  plannedQty: z.number().min(0).max(1e9).optional(),
  loadedQty: z.number().min(0).max(1e9).optional(),
  deliveredQty: z.number().min(0).max(1e9).optional(),
  litres20: z.number().min(0).max(1e9).optional(),
  pieces: z.number().min(0).max(1e9).optional(),
  grossKg: z.number().min(0).max(1e9).optional(),
  volumeM3: z.number().min(0).max(1e6).optional(),
  declaredValue: z.number().min(0).max(1e12).optional(),
  km: z.number().min(0).max(1e5).optional(),
  pickups: z.number().int().min(1).max(50).optional(),
  drops: z.number().int().min(1).max(50).optional(),
});
export const tryTariffSchema = z.strictObject({
  /** A tariff as the editor holds it, saved or not. Left out on `/tariffs/:id/try`. */
  tariff: createTariffSchema.partial({ code: true, name: true }).optional(),
  consignmentId: objectId.optional(),
  sample: sample.optional(),
}).refine((v) => v.consignmentId || v.sample, 'Pick a consignment or type sample figures');
export type TryTariffInput = z.infer<typeof tryTariffSchema>;

/** Plain figures as a consignment the engine can price: one goods line, its pickups and drops done. */
function sampleFacts(s: z.infer<typeof sample>, currency: { id: string; code: string; minorUnits: number }): PricingFacts {
  const unit = s.unit ?? (s.litres20 !== undefined ? 'L' : 't');
  const ups = s.pickups ?? 1, downs = s.drops ?? 1;
  const loaded = s.loadedQty ?? s.plannedQty ?? 0;
  const delivered = s.deliveredQty;
  const measure = (qty: number) => ({ lineId: 'sample', qty, unit, ...(s.litres20 !== undefined ? { certStd20L: qty * (s.litres20 / (loaded || 1)) } : {}), ...(s.pieces !== undefined ? { pieces: s.pieces } : {}) });
  return {
    number: 'Sample', pricedOn: new Date(), currency,
    lines: [{ id: 'sample', productId: s.productId ?? 'sample', plannedQty: s.plannedQty ?? loaded, unit, pieces: s.pieces, grossKg: s.grossKg, volumeM3: s.volumeM3, declaredValueMinor: s.declaredValue !== undefined ? s.declaredValue * 10 ** currency.minorUnits : undefined, product: { volumeCorrected: s.litres20 !== undefined } }],
    legs: [
      ...Array.from({ length: ups }, (_, i) => ({ id: `p${i}`, kind: 'pickup' as const, status: (loaded ? 'done' : 'planned') as 'done' | 'planned', actual: loaded ? [measure(loaded / ups)] : undefined })),
      ...Array.from({ length: downs }, (_, i) => ({ id: `d${i}`, kind: 'drop' as const, status: (delivered !== undefined ? 'done' : 'planned') as 'done' | 'planned', outcome: 'delivered' as const, actual: delivered !== undefined ? [measure(delivered / downs)] : undefined })),
    ],
    distance: { leadKm: s.km, tripLoadedKm: s.km, manualKm: s.km, tripKm: s.km },
    perTrip: { carries: true },
  };
}

/** "Try it" in the tariff editor (design 3.11.9 point 5): its problems first, then the price of a consignment or of sample figures. */
export async function tryTariff(input: TryTariffInput, savedId: string | undefined, ctx: OpsContext) {
  void ctx;
  let tariff: Plain;
  if (savedId) {
    const saved = await Tariff.findById(savedId).lean<Plain>();
    if (!saved) throw new NotFoundError('Tariff not found');
    tariff = input.tariff ? { ...saved, ...input.tariff } : saved;
  } else {
    if (!input.tariff) throw refuse('Send the tariff to try.');
    tariff = { _id: new Types.ObjectId(), code: input.tariff.code ?? 'DRAFT', name: input.tariff.name ?? 'Tariff being edited', ...input.tariff };
  }
  tariff.lines = ((tariff.lines ?? []) as Plain[]).map((l) => ({ ...l, _id: l._id ?? new Types.ObjectId() }));
  const asInput = tariffInput(tariff, 'the tariff being tried');
  const problems = checkTariff(asInput);
  if (problems.length) return { problems, result: null, facts: null };
  if (input.consignmentId) {
    const c = await Consignment.findById(input.consignmentId).lean<Plain>();
    if (!c) throw new NotFoundError('Consignment not found');
    // What it would come to with this tariff: as if never priced, so a frozen price doesn't hide the answer.
    const priced = await priceOf({ ...c, revenue: c.revenue ? { ...(c.revenue as Plain), status: 'estimated' } : undefined }, { tariff });
    return { problems, result: priced.result, facts: priced.facts };
  }
  const currency = await Currency.findById(tariff.currencyId).select('code minorUnits').lean<Plain>();
  if (!currency) throw refuse('Choose the tariff\'s currency first.');
  const facts = sampleFacts(input.sample!, { id: String(currency._id), code: String(currency.code), minorUnits: Number(currency.minorUnits ?? 2) });
  return { problems, result: priceConsignment(facts, asInput, await engineSettings()), facts };
}

/** Whether a tariff applies to a consignment, and which one wins: "why didn't this tariff apply?". */
export async function matchFor(tariffId: string, consignmentId: string) {
  const [tariff, c] = await Promise.all([Tariff.findById(tariffId).lean<Plain>(), Consignment.findById(consignmentId).lean<Plain>()]);
  if (!tariff) throw new NotFoundError('Tariff not found');
  if (!c) throw new NotFoundError('Consignment not found');
  const trip = c.tripId ? await Trip.findById(c.tripId).lean<Plain>() : null;
  const settings = await freightSettings();
  const on = pricingDay(c, trip, String(tariff.priceOn ?? settings.priceOnDefault));
  const subject = await subjectOf(c, trip);
  const alone = matchTariff([tariff], subject, on);
  const all = await Tariff.find({ status: 'active' }).lean<Plain[]>();
  const winner = matchTariff(all, subject, on);
  return {
    matches: Boolean(alone), pricedOn: on,
    tariff: alone ? { id: String(tariff._id), code: tariff.code, matchedOn: alone.matchedOn, score: alone.score } : null,
    winner: winner ? { id: String(winner.tariff._id), code: winner.tariff.code, matchedOn: winner.matchedOn, score: winner.score } : null,
  };
}

/* Revenue routes' bodies. */
export const manualPriceSchema = z.strictObject({ amount: money.refine((m) => m.amountMinor >= 0, 'Enter the price'), reason: text(300).optional(), whole: z.boolean().optional() });
export const chargeLineSchema = z.strictObject({ chargeTypeId: objectId, description: text(200).optional(), qty: z.number().min(0).max(1e9).optional(), unitPrice: money, note: text(300).optional() });
export const acceptLineSchema = z.strictObject({ accepted: z.boolean() });
export const reasonBody = z.strictObject({ reason: text(500) });
export const lineParams = z.strictObject({ id: objectId, lineId: objectId });
export const matchQuery = z.strictObject({ consignmentId: objectId });
export const previewQuery = z.strictObject({ preview: z.enum(['0', '1', 'true', 'false']).optional() });

/** The facts the engine reads for one consignment, for the tariff editor's variable list with values. */
export async function factsOf(consignmentId: string) {
  const c = await Consignment.findById(consignmentId).lean<Plain>();
  if (!c) throw new NotFoundError('Consignment not found');
  const priced = await priceOf(c);
  return priced.facts;
}
