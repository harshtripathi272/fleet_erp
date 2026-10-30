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

export const currencyDefinition = defineMaster({
  key: 'currencies', label: 'Currencies', singular: 'Currency', group: GROUPS.money,
  description: 'ZMW, USD, TZS, CDF… Money is stored in minor units (ngwee, cents); minorUnits says how many decimals the currency has.',
  model: Currency, createSchema: S.createCurrencySchema, updateSchema: S.updateCurrencySchema,
  immutable: ['code', 'minorUnits'],
});

export const exchangeRateDefinition = defineMaster({
  key: 'exchange-rates', label: 'Exchange rates', singular: 'Exchange rate', group: GROUPS.money,
  description: '1 base = rate × quote on a date. Conversions use the latest rate on or before the requested date, or its inverse.',
  model: ExchangeRate, createSchema: S.createExchangeRateSchema, updateSchema: S.updateExchangeRateSchema,
  searchFields: ['source', 'notes'], sortFields: ['effectiveDate', 'rate', 'createdAt', 'updatedAt'], defaultSort: '-effectiveDate', titleField: 'rate',
  refs: [{ path: 'baseCurrencyId', target: 'currencies' }, { path: 'quoteCurrencyId', target: 'currencies' }],
  immutable: ['baseCurrencyId', 'quoteCurrencyId'],
  filters: {
    currencyId: { schema: idQuery, apply: (v: string) => ({ $or: [{ baseCurrencyId: new Types.ObjectId(v) }, { quoteCurrencyId: new Types.ObjectId(v) }] }), description: 'Rates involving this currency' },
  },
  async prepare(data: Plain) {
    if (String(data.baseCurrencyId) === String(data.quoteCurrencyId)) throw new ValidationError('Base and quote currencies must differ', { quoteCurrencyId: ['Same as base'] });
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

/** Converts an amount in minor units using the latest rate on or before `date`. */
export async function convertMoney(query: S.ConvertMoneyQuery) {
  const currencies = await Currency.find({ _id: { $in: [query.fromCurrencyId, query.toCurrencyId] } }).lean();
  const from = currencies.find((c) => String(c._id) === query.fromCurrencyId);
  const to = currencies.find((c) => String(c._id) === query.toCurrencyId);
  if (!from || !to) throw new NotFoundError('Currency not found');
  const date = query.date ?? new Date();
  if (query.fromCurrencyId === query.toCurrencyId) return { amountMinor: query.amountMinor, resultMinor: query.amountMinor, rate: 1, method: 'identity', effectiveDate: null };
  const latest = (base: string, quote: string) => ExchangeRate.findOne({ baseCurrencyId: base, quoteCurrencyId: quote, status: 'active', effectiveDate: { $lte: date } }).sort({ effectiveDate: -1 }).lean();
  const direct = await latest(query.fromCurrencyId, query.toCurrencyId);
  const inverse = direct ? null : await latest(query.toCurrencyId, query.fromCurrencyId);
  const record = direct ?? inverse;
  if (!record) throw new NotFoundError(`No ${from.code}→${to.code} rate on or before ${date.toISOString().slice(0, 10)}`);
  const rate = direct ? Number(record.rate) : 1 / Number(record.rate);
  const major = query.amountMinor / 10 ** Number(from.minorUnits ?? 2);
  const resultMinor = Math.round(major * rate * 10 ** Number(to.minorUnits ?? 2));
  return {
    amountMinor: query.amountMinor, resultMinor, rate, method: direct ? 'direct' : 'inverse',
    effectiveDate: record.effectiveDate, rateId: String(record._id), from: from.code, to: to.code,
  };
}

export const masters: MasterDefinition[] = [currencyDefinition, exchangeRateDefinition, paymentMethodDefinition];
