import { ObjectId, masterSchema, masterModel } from '../../../core/masters/schema.js';

export const RATE_SOURCES = ['manual', 'bank', 'feed'] as const;

/** 1 unit of the base currency = `rate` units of the quote currency on `effectiveDate`. */
const exchangeRateSchema = masterSchema({
  baseCurrencyId: { type: ObjectId, ref: 'Currency', required: true },
  quoteCurrencyId: { type: ObjectId, ref: 'Currency', required: true },
  /** The mid rate. */
  rate: { type: Number, required: true },
  /** The bank's buying and selling rates, when known; conversions use them when Money settings say so. */
  buyingRate: Number,
  sellingRate: Number,
  effectiveDate: { type: Date, required: true },
  source: { type: String, enum: RATE_SOURCES, default: 'manual' },
});
exchangeRateSchema.index({ baseCurrencyId: 1, quoteCurrencyId: 1, effectiveDate: -1 }, { unique: true });

export const ExchangeRate = masterModel('ExchangeRate', exchangeRateSchema);
