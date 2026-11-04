import { Types } from 'mongoose';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '../../core/errors/index.js';
import { defineMaster } from '../../core/masters/define.js';
import { GROUPS } from '../../core/masters/groups.js';
import { boolQuery, idQuery } from '../../core/masters/query.js';
import type { MasterDefinition, Plain } from '../../core/masters/types.js';
import * as S from './finance.schema.js';
import { Currency } from './models/currency.model.js';
import { ExchangeRate } from './models/exchangeRate.model.js';
import { PAYMENT_KINDS, PaymentMethod } from './models/paymentMethod.model.js';
import { type MoneySettings, moneySettings, pivotCurrency } from './settings.service.js';

export const currencyDefinition = defineMaster({
  key: 'currencies', label: 'Currencies', singular: 'Currency', group: GROUPS.money,
  description: 'ZMW, USD, TZS, CDF… Money is stored in minor units (ngwee, cents); minorUnits says how many decimals the currency has.',
  model: Currency, createSchema: S.createCurrencySchema, updateSchema: S.updateCurrencySchema,
  immutable: ['code', 'minorUnits'],
});

export const exchangeRateDefinition = defineMaster({
  key: 'exchange-rates', label: 'Exchange rates', singular: 'Exchange rate', group: GROUPS.money,
  description: '1 base = rate × quote on a date. Conversions use the latest rate on or before the requested date, or its inverse, or go through the pivot currency (Money settings).',
  labels: { rate: 'Mid rate' },
  hints: { buyingRate: "The bank's buying rate, if you use it (Money settings → Which rate to convert at). Left empty, the mid rate is used.", sellingRate: "The bank's selling rate, if you use it. Left empty, the mid rate is used." },
  model: ExchangeRate, createSchema: S.createExchangeRateSchema, updateSchema: S.updateExchangeRateSchema,
  searchFields: ['source', 'notes'], sortFields: ['effectiveDate', 'rate', 'createdAt', 'updatedAt'], defaultSort: '-effectiveDate', titleField: 'rate',
  refs: [{ path: 'baseCurrencyId', target: 'currencies' }, { path: 'quoteCurrencyId', target: 'currencies' }],
  immutable: ['baseCurrencyId', 'quoteCurrencyId'],
  filters: {
    currencyId: { schema: idQuery, apply: (v: string) => ({ $or: [{ baseCurrencyId: new Types.ObjectId(v) }, { quoteCurrencyId: new Types.ObjectId(v) }] }), description: 'Rates involving this currency' },
  },
  async prepare(data: Plain, ctx) {
    if (String(data.baseCurrencyId) === String(data.quoteCurrencyId)) throw new ValidationError('Base and quote currencies must differ', { quoteCurrencyId: ['Same as base'] });
    // A rate typed in (manual or bank) replaces the feed's rate for that pair and day, in either direction.
    if (ctx.mode === 'create' && data.source !== 'feed' && data.effectiveDate) {
      await ExchangeRate.deleteMany({
        source: 'feed', effectiveDate: new Date(String(data.effectiveDate)),
        $or: [{ baseCurrencyId: data.baseCurrencyId, quoteCurrencyId: data.quoteCurrencyId }, { baseCurrencyId: data.quoteCurrencyId, quoteCurrencyId: data.baseCurrencyId }],
      });
    }
    return data;
  },
});

export const paymentMethodDefinition = defineMaster({
  key: 'payment-methods', label: 'Payment methods', singular: 'Payment method', group: GROUPS.money,
  description: 'How cash and fuel reach a driver or supplier: cash, mobile money (Airtel Money, MTN MoMo), bank, fuel card, voucher, own depot.',
  model: PaymentMethod, createSchema: S.createPaymentMethodSchema, updateSchema: S.updatePaymentMethodSchema,
  refs: [{ path: 'currencyIds', target: 'currencies' }],
  filters: {
    kind: { schema: z.enum(PAYMENT_KINDS), apply: (v: string) => ({ kind: v }), description: 'Payment kind' },
    forFuel: { schema: boolQuery, apply: (v: boolean) => ({ forFuel: v }), description: 'Usable for fuel' },
    forCash: { schema: boolQuery, apply: (v: boolean) => ({ forCash: v }), description: 'Usable for cash' },
  },
  async prepare(data: Plain) {
    if (!data.forFuel && !data.forCash && data.forFuel !== undefined && data.forCash !== undefined) {
      throw new ValidationError('A payment method must be usable for fuel, cash or both', { forCash: ['Both are false'] });
    }
    return data;
  },
});

type RateRecord = { _id: unknown; rate: number; buyingRate?: number; sellingRate?: number; effectiveDate: Date };

export interface Rate {
  /** 1 unit of `from` = rate units of `to`. */
  rate: number;
  method: 'identity' | 'direct' | 'inverse' | 'pivot';
  /** The rate's date; through a pivot, the older of its two rates. */
  effectiveDate: Date | null;
  rateId?: string;
  /** Through a pivot: the pivot currency's code. */
  via?: string;
  /** Which of the day's rates was used: mid, buying or selling (a rate without that figure gives its mid). */
  basis: MoneySettings['rateBasis'];
}

const figure = (r: RateRecord, basis: MoneySettings['rateBasis']) =>
  Number((basis === 'buying' ? r.buyingRate : basis === 'selling' ? r.sellingRate : undefined) ?? r.rate);

/** The latest rate between two currencies on or before `date`, direct or inverse, or undefined. */
async function pairRate(from: string, to: string, date: Date, basis: MoneySettings['rateBasis']) {
  const latest = (base: string, quote: string) => ExchangeRate.findOne({ baseCurrencyId: base, quoteCurrencyId: quote, status: 'active', effectiveDate: { $lte: date } }).sort({ effectiveDate: -1 }).lean<RateRecord>();
  const direct = await latest(from, to);
  if (direct) return { rate: figure(direct, basis), method: 'direct' as const, effectiveDate: direct.effectiveDate, rateId: String(direct._id) };
  const inverse = await latest(to, from);
  if (inverse) return { rate: 1 / figure(inverse, basis), method: 'inverse' as const, effectiveDate: inverse.effectiveDate, rateId: String(inverse._id) };
  return undefined;
}

/**
 * The rate from one currency to another on `date`, following Money settings: the mid, buying or selling rate,
 * and through the pivot currency (USD by default) when there is no rate between the two. Refused with a
 * sentence saying what to add, or that converting through the pivot is switched off.
 */
export async function rateBetween(fromCurrencyId: string, toCurrencyId: string, date: Date, codes?: { from: string; to: string }): Promise<Rate> {
  const settings = await moneySettings();
  const basis = settings.rateBasis;
  if (fromCurrencyId === toCurrencyId) return { rate: 1, method: 'identity', effectiveDate: null, basis };
  const found = await pairRate(fromCurrencyId, toCurrencyId, date, basis);
  if (found) return { ...found, basis };
  const label = codes ?? await currencyCodes(fromCurrencyId, toCurrencyId);
  const day = date.toISOString().slice(0, 10);
  const missing = `No ${label.from}→${label.to} rate on or before ${day}`;
  if (!settings.viaPivot) throw new NotFoundError(`${missing}, and converting through another currency is switched off (Money settings)`);
  const pivot = await pivotCurrency(settings);
  if (!pivot || pivot.id === fromCurrencyId || pivot.id === toCurrencyId) throw new NotFoundError(missing);
  const [first, second] = await Promise.all([pairRate(fromCurrencyId, pivot.id, date, basis), pairRate(pivot.id, toCurrencyId, date, basis)]);
  if (!first || !second) throw new NotFoundError(`${missing}, directly or through ${pivot.code} (no ${first ? pivot.code : label.from}→${first ? label.to : pivot.code} rate)`);
  return {
    rate: first.rate * second.rate, method: 'pivot', via: pivot.code, basis,
    effectiveDate: first.effectiveDate < second.effectiveDate ? first.effectiveDate : second.effectiveDate,
  };
}

async function currencyCodes(fromId: string, toId: string) {
  const list = await Currency.find({ _id: { $in: [fromId, toId] } }).select('code').lean();
  const code = (id: string) => String(list.find((c) => String(c._id) === id)?.code ?? '?');
  return { from: code(fromId), to: code(toId) };
}

/** Minor units of one currency in another at `rate`, rounded to the nearest minor unit. */
export const applyRate = (amountMinor: number, rate: number, fromMinorUnits: number, toMinorUnits: number) =>
  Math.round((amountMinor / 10 ** fromMinorUnits) * rate * 10 ** toMinorUnits);

/** Converts an amount in minor units using the latest rate on or before `date` (see rateBetween). */
export async function convertMoney(query: S.ConvertMoneyQuery) {
  const currencies = await Currency.find({ _id: { $in: [query.fromCurrencyId, query.toCurrencyId] } }).lean();
  const from = currencies.find((c) => String(c._id) === query.fromCurrencyId);
  const to = currencies.find((c) => String(c._id) === query.toCurrencyId);
  if (!from || !to) throw new NotFoundError('Currency not found');
  const date = query.date ?? new Date();
  if (query.fromCurrencyId === query.toCurrencyId) return { amountMinor: query.amountMinor, resultMinor: query.amountMinor, rate: 1, method: 'identity', effectiveDate: null };
  const r = await rateBetween(query.fromCurrencyId, query.toCurrencyId, date, { from: String(from.code), to: String(to.code) });
  const resultMinor = applyRate(query.amountMinor, r.rate, Number(from.minorUnits ?? 2), Number(to.minorUnits ?? 2));
  return {
    amountMinor: query.amountMinor, resultMinor, rate: r.rate, method: r.method, basis: r.basis, ...(r.via ? { via: r.via } : {}),
    effectiveDate: r.effectiveDate, ...(r.rateId ? { rateId: r.rateId } : {}), from: from.code, to: to.code,
  };
}

export const masters: MasterDefinition[] = [currencyDefinition, exchangeRateDefinition, paymentMethodDefinition];
