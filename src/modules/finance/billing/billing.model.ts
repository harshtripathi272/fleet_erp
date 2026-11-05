import { Schema, model } from 'mongoose';
import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, masterModel, masterSchema, moneySchema, schemaOptions } from '../../../core/masters/schema.js';

/* ---------- Masters ---------- */

/** How a customer rate is charged: per trip, per tonne, per litre at 20 °C, or per km driven loaded. */
export const RATE_BASES = ['per_trip', 'per_tonne', 'per_litre_20', 'per_km'] as const;

/** What a customer pays to move a load: for a customer, optionally a route and a product, for dates. */
const customerRateSchema = masterSchema({
  ...codeNameFields,
  customerId: { type: ObjectId, ref: 'Party', required: true },
  routeId: { type: ObjectId, ref: 'Route' },
  productId: { type: ObjectId, ref: 'Product' },
  basis: { type: String, enum: RATE_BASES, required: true },
  price: { type: moneySchema, required: true },
  /** The least a trip is charged, in the price's currency. */
  minimumCharge: { type: moneySchema, default: undefined },
  // Its dates are the master's own validFrom and validTo.
  /** VAT on this rate, when tax is set per customer or product. */
  taxRatePercent: { type: Number, min: 0, max: 100 },
});
uniqueIndex(customerRateSchema, { code: 1 });
customerRateSchema.index({ customerId: 1, status: 1, validFrom: -1 });

export const CustomerRate = masterModel('CustomerRate', customerRateSchema);

/* ---------- Documents ---------- */

export const LINE_KINDS = ['freight', 'minimum', 'shortage', 'other'] as const;

const lineSchema = new Schema({
  kind: { type: String, enum: LINE_KINDS, required: true },
  description: { type: String, required: true },
  tripId: { type: ObjectId, ref: 'Trip' },
  consignmentId: { type: ObjectId, ref: 'Consignment' },
  rateId: { type: ObjectId, ref: 'CustomerRate' },
  qty: { type: Number, required: true },
  unit: String,
  /** In the invoice's currency. Negative for a deduction. */
  unitPriceMinor: { type: Number, required: true },
  /** qty × unit price as charged: tax included when the company's prices include it. */
  amountMinor: { type: Number, required: true },
  taxPercent: { type: Number, default: 0 },
  taxMinor: { type: Number, default: 0 },
  /** Before tax. */
  netMinor: { type: Number, required: true },
}, { _id: true, strict: 'throw' });

export const INVOICE_KINDS = ['invoice', 'credit_note'] as const;
export const INVOICE_STATUSES = ['draft', 'approved', 'cancelled'] as const;
export const PAYMENT_STATES = ['unpaid', 'part_paid', 'paid'] as const;

/**
 * An invoice to a customer, or a credit note against one. Drafts are priced from closed trips; approving
 * numbers it and fixes its rate to the base currency on the invoice's date. `baseOpenMinor` is what is still
 * owed at that rate, which a payment's exchange gain or loss is measured against.
 */
const invoiceSchema = new Schema<any>({
  kind: { type: String, enum: INVOICE_KINDS, default: 'invoice' },
  number: String,
  customerId: { type: ObjectId, ref: 'Party', required: true },
  /** A credit note's invoice. */
  invoiceId: { type: ObjectId, ref: 'Invoice' },
  nominationId: { type: ObjectId, ref: 'Nomination' },
  tripIds: { type: [{ type: ObjectId, ref: 'Trip' }], default: [] },
  currencyId: { type: ObjectId, ref: 'Currency', required: true },
  date: { type: Date, required: true },
  dueDate: Date,
  lines: { type: [lineSchema], default: [] },
  netMinor: { type: Number, required: true },
  taxMinor: { type: Number, required: true },
  totalMinor: { type: Number, required: true },
  taxLabel: String,
  pricesIncludeTax: Boolean,
  /** 1 unit of the invoice's currency in the base currency, fixed on approval. */
  rateToBase: Number,
  baseTotalMinor: Number,
  /** Still owed, in the invoice's currency and in the base currency at the invoice's rate. */
  openMinor: Number,
  baseOpenMinor: Number,
  creditedMinor: { type: Number, default: 0 },
  paidMinor: { type: Number, default: 0 },
  status: { type: String, enum: INVOICE_STATUSES, default: 'draft' },
  paymentState: { type: String, enum: PAYMENT_STATES },
  note: String,
  reason: String,
  approvedAt: Date,
  approvedBy: { type: ObjectId, ref: 'User' },
  sentAt: Date,
  fileId: { type: ObjectId, ref: 'StoredFile' },
  cancelledAt: Date,
  createdBy: { type: ObjectId, ref: 'User' },
  updatedBy: { type: ObjectId, ref: 'User' },
}, schemaOptions);
invoiceSchema.index({ number: 1 }, { unique: true, partialFilterExpression: { number: { $type: 'string' } } });
invoiceSchema.index({ customerId: 1, status: 1, date: 1 });
invoiceSchema.index({ tripIds: 1 });
invoiceSchema.index({ invoiceId: 1 }, { sparse: true });
invoiceSchema.index({ date: -1 });
invoiceSchema.index({ updatedAt: 1 });

export const Invoice = model<any>('Invoice', invoiceSchema);

const allocationSchema = new Schema({
  invoiceId: { type: ObjectId, ref: 'Invoice', required: true },
  invoiceNumber: String,
  /** Of the payment, in the payment's currency. */
  amountMinor: { type: Number, required: true },
  /** What it settles of the invoice, in the invoice's currency. */
  settledMinor: { type: Number, required: true },
  /** The settled part in the base currency: at the invoice's rate, and at the payment's. */
  bookedBaseMinor: { type: Number, required: true },
  receivedBaseMinor: { type: Number, required: true },
  /** receivedBase − bookedBase: positive is a gain, negative a loss. */
  gainLossBaseMinor: { type: Number, required: true },
}, { _id: false, strict: 'throw' });

/** Money received from a customer, in any currency, set against one or more of its invoices. */
const customerPaymentSchema = new Schema<any>({
  number: { type: String, required: true },
  customerId: { type: ObjectId, ref: 'Party', required: true },
  date: { type: Date, required: true },
  amount: { type: moneySchema, required: true },
  /** 1 unit of the payment's currency in the base currency on its date. */
  rateToBase: { type: Number, required: true },
  baseAmountMinor: { type: Number, required: true },
  paymentMethodId: { type: ObjectId, ref: 'PaymentMethod' },
  reference: String,
  allocations: { type: [allocationSchema], default: [] },
  /** Received but not yet set against an invoice, in the payment's currency. */
  unallocatedMinor: { type: Number, required: true },
  note: String,
  createdBy: { type: ObjectId, ref: 'User' },
  updatedBy: { type: ObjectId, ref: 'User' },
}, schemaOptions);
customerPaymentSchema.index({ number: 1 }, { unique: true });
customerPaymentSchema.index({ customerId: 1, date: -1 });
customerPaymentSchema.index({ 'allocations.invoiceId': 1 });
customerPaymentSchema.index({ updatedAt: 1 });

export const CustomerPayment = model<any>('CustomerPayment', customerPaymentSchema);

export const DIFFERENCE_KINDS = ['realised', 'unrealised', 'reversal'] as const;

/**
 * An exchange gain or loss in the base currency, for the accounts: realised when a payment settles a
 * foreign-currency invoice at a different rate. (Revaluation of open invoices, #62, adds unrealised ones.)
 */
const exchangeDifferenceSchema = new Schema<any>({
  kind: { type: String, enum: DIFFERENCE_KINDS, required: true },
  date: { type: Date, required: true },
  customerId: { type: ObjectId, ref: 'Party' },
  invoiceId: { type: ObjectId, ref: 'Invoice', required: true },
  paymentId: { type: ObjectId, ref: 'CustomerPayment' },
  /** The invoice's currency, and the base currency the amount is in. */
  currencyId: { type: ObjectId, ref: 'Currency', required: true },
  baseCurrencyId: { type: ObjectId, ref: 'Currency', required: true },
  /** Positive is a gain, negative a loss. */
  amountMinor: { type: Number, required: true },
  bookedRate: Number,
  actualRate: Number,
  /** The revaluation run that recorded it (unrealised and reversal entries). */
  runId: { type: ObjectId, ref: 'RevaluationRun' },
  /** A reversal's unrealised entry. */
  reversesId: { type: ObjectId, ref: 'ExchangeDifference' },
  createdBy: { type: ObjectId, ref: 'User' },
}, { ...schemaOptions, optimisticConcurrency: false });
exchangeDifferenceSchema.index({ date: 1 });
exchangeDifferenceSchema.index({ invoiceId: 1 });
exchangeDifferenceSchema.index({ runId: 1 }, { sparse: true });

export const ExchangeDifference = model<any>('ExchangeDifference', exchangeDifferenceSchema);

/**
 * One revaluation of open foreign-currency invoices at a month's or quarter's end (#62): each invoice's
 * open amount at that day's rate against what it is booked at. The next run reverses it first.
 */
const revaluationRunSchema = new Schema<any>({
  periodEnd: { type: Date, required: true },
  at: { type: Date, required: true },
  trigger: { type: String, enum: ['schedule', 'manual'], required: true },
  invoices: { type: Number, default: 0 },
  /** Net unrealised gain (positive) or loss in the base currency, and what was reversed from the run before. */
  netMinor: { type: Number, default: 0 },
  reversedMinor: { type: Number, default: 0 },
  reversedRunId: { type: ObjectId, ref: 'RevaluationRun' },
  /** Currencies with no rate on the day: their invoices were left as booked. */
  missing: { type: [String], default: [] },
  createdBy: { type: ObjectId, ref: 'User' },
}, { versionKey: false, strict: 'throw' });
revaluationRunSchema.index({ periodEnd: 1 }, { unique: true });

export const RevaluationRun = model<any>('RevaluationRun', revaluationRunSchema);

/** What each line of the accounting export posts to (#62). An account code names the ones it takes. */
export const POSTING_ROLES = [
  'receivables', 'revenue', 'tax', 'bank', 'exchange_gain', 'exchange_loss', 'unrealised_exchange', 'driver_advances', 'expenses',
] as const;

/** One of the company's own account codes, and the postings it takes in the accounting export. */
const accountCodeSchema = masterSchema({
  ...codeNameFields,
  postsFor: { type: [{ type: String, enum: POSTING_ROLES }], default: [] },
});
uniqueIndex(accountCodeSchema, { code: 1 });

export const AccountCode = masterModel('AccountCode', accountCodeSchema);
