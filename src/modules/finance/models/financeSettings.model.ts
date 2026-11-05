import { Schema, model } from 'mongoose';
import { ObjectId } from '../../../core/masters/schema.js';

/**
 * The company's money and billing rules (#61), one document. Each value is a company setting with the default
 * named here; nothing about how a company converts, taxes or invoices is fixed in code.
 */
export const RATE_BASES = ['mid', 'buying', 'selling'] as const;
export const TAX_MODES = ['none', 'single', 'per_customer_product'] as const;
export const INVOICE_FROM = ['trip', 'nomination', 'on_demand'] as const;
export const BILL_ON = ['delivered', 'loaded'] as const;
export const SHORTAGE_ON_INVOICE = ['deduct', 'none'] as const;

export const MONEY_DEFAULTS = {
  /** Which of a day's rates conversions use. A rate without a buying or selling figure falls back to its mid rate. */
  rateBasis: 'mid' as (typeof RATE_BASES)[number],
  /** With no direct rate between two currencies, convert through the pivot currency (TZS → USD → ZMW). */
  viaPivot: true,
  /** The pivot currency; when unset, the currency with code USD. */
  pivotCurrencyId: undefined as string | undefined,
};

export const BILLING_DEFAULTS = {
  taxMode: 'none' as (typeof TAX_MODES)[number],
  /** The VAT rate for "one VAT rate", and the fallback for "per customer or product". */
  taxRatePercent: 0,
  taxLabel: 'VAT',
  pricesIncludeTax: false,
  invoiceFrom: 'trip' as (typeof INVOICE_FROM)[number],
  paymentTermsDays: 30,
  /** Which quantity a per-tonne or per-litre rate is charged on. */
  billOn: 'delivered' as (typeof BILL_ON)[number],
  /** A shortage beyond the allowance is taken off the customer's invoice at the shortage price. */
  shortageOnInvoice: 'deduct' as (typeof SHORTAGE_ON_INVOICE)[number],
};

const moneyPart = new Schema({
  rateBasis: { type: String, enum: RATE_BASES },
  viaPivot: Boolean,
  pivotCurrencyId: { type: ObjectId, ref: 'Currency' },
}, { _id: false, strict: 'throw' });

const billingPart = new Schema({
  taxMode: { type: String, enum: TAX_MODES },
  taxRatePercent: { type: Number, min: 0, max: 100 },
  taxLabel: String,
  pricesIncludeTax: Boolean,
  invoiceFrom: { type: String, enum: INVOICE_FROM },
  paymentTermsDays: { type: Number, min: 0, max: 365 },
  billOn: { type: String, enum: BILL_ON },
  shortageOnInvoice: { type: String, enum: SHORTAGE_ON_INVOICE },
}, { _id: false, strict: 'throw' });

const financeSettingsSchema = new Schema({
  _id: { type: String, default: 'finance' },
  money: { type: moneyPart, default: () => ({}) },
  billing: { type: billingPart, default: () => ({}) },
  version: { type: Number, default: 0 },
  updatedBy: { type: ObjectId, ref: 'User' },
}, { timestamps: true, versionKey: false, strict: 'throw', collection: 'finance_settings', minimize: false });

export const FinanceSettings = model('FinanceSettings', financeSettingsSchema);
