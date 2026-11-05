import { z } from 'zod';
import { baseShape, idList, integer, isoDate, name, objectId, positive, text, toUpdateSchema } from '../../core/masters/zod.js';
import { RATE_SOURCES } from './models/exchangeRate.model.js';
import { PAYMENT_KINDS } from './models/paymentMethod.model.js';

export const currencyShape = {
  code: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'ISO 4217 code, e.g. USD'),
  name, description: text(500).optional(),
  symbol: text(8).optional(),
  minorUnits: integer(0, 4).optional(),
  ...baseShape,
};

/** Rates are dates without times (stored at 00:00 UTC). */
const day = isoDate.transform((d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())));

export const exchangeRateShape = {
  baseCurrencyId: objectId,
  quoteCurrencyId: objectId,
  rate: positive,
  effectiveDate: day,
  source: z.enum(RATE_SOURCES).optional(),
  ...baseShape,
};

export const paymentMethodShape = {
  code: z.string().trim().min(1).max(32).transform((v) => v.toUpperCase()).pipe(z.string().regex(/^[A-Z0-9][A-Z0-9._\-/]*$/)),
  name, description: text(500).optional(),
  kind: z.enum(PAYMENT_KINDS),
  provider: text(80).optional(),
  referenceRequired: z.boolean().optional(),
  currencyIds: idList(20).optional(),
  forFuel: z.boolean().optional(),
  forCash: z.boolean().optional(),
  ...baseShape,
};

export const createCurrencySchema = z.strictObject(currencyShape);
export const updateCurrencySchema = toUpdateSchema(currencyShape);
export const createExchangeRateSchema = z.strictObject(exchangeRateShape);
export const updateExchangeRateSchema = toUpdateSchema(exchangeRateShape);
export const createPaymentMethodSchema = z.strictObject(paymentMethodShape);
export const updatePaymentMethodSchema = toUpdateSchema(paymentMethodShape);

export const convertMoneyQuerySchema = z.strictObject({
  fromCurrencyId: objectId,
  toCurrencyId: objectId,
  amountMinor: z.coerce.number().int().min(0).max(1e13),
  date: day.optional(),
});
export type ConvertMoneyQuery = z.infer<typeof convertMoneyQuerySchema>;

/** Exchange rates → Rate feed. The provider's key is the RATE_FEED_API_KEY secret, never sent here. */
export const rateFeedSettingsSchema = z.strictObject({
  provider: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/).optional(),
  currencyIds: z.array(objectId).max(200).optional(),
  fetchAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'A time such as 06:00').optional(),
}).refine((v) => Object.keys(v).length > 0, 'Send at least one setting');
