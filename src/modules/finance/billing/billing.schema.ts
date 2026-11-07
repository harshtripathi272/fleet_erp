import { z } from 'zod';
import { baseShape, code, integer, isoDate, money, name, objectId, percent, text, toUpdateSchema } from '../../../core/masters/zod.js';
import { BILL_ON, INVOICE_FROM, RATE_BASES as CONVERT_AT, REVALUATION, SHORTAGE_ON_INVOICE, TAX_MODES } from '../models/financeSettings.model.js';
import { POSTING_ROLES, RATE_BASES } from './billing.model.js';

const day = isoDate.transform((d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())));

/* ---------- Masters ---------- */

export const customerRateShape = {
  code, name, description: text(500).optional(),
  customerId: objectId,
  routeId: objectId.optional(),
  productId: objectId.optional(),
  basis: z.enum(RATE_BASES),
  price: money,
  minimumCharge: money.optional(),
  taxRatePercent: percent.optional(),
  ...baseShape,
  // Left out, a rate applies from any date, so it also covers trips closed before it was added.
  validFrom: day.optional(),
  validTo: day.optional(),
};
export const createCustomerRateSchema = z.strictObject(customerRateShape);
export const updateCustomerRateSchema = toUpdateSchema(customerRateShape);

export const accountCodeShape = {
  code, name, description: text(500).optional(),
  postsFor: z.array(z.enum(POSTING_ROLES)).max(POSTING_ROLES.length).refine((v) => new Set(v).size === v.length, 'Each posting once').optional(),
  ...baseShape,
};
export const createAccountCodeSchema = z.strictObject(accountCodeShape);
export const updateAccountCodeSchema = toUpdateSchema(accountCodeShape);

/* ---------- Settings ---------- */

export const financeSettingsSchema = z.strictObject({
  money: z.strictObject({
    rateBasis: z.enum(CONVERT_AT).nullable().optional(),
    viaPivot: z.boolean().nullable().optional(),
    pivotCurrencyId: objectId.nullable().optional(),
  }).optional(),
  billing: z.strictObject({
    taxMode: z.enum(TAX_MODES).nullable().optional(),
    taxRatePercent: percent.nullable().optional(),
    taxLabel: text(20).nullable().optional(),
    pricesIncludeTax: z.boolean().nullable().optional(),
    invoiceFrom: z.enum(INVOICE_FROM).nullable().optional(),
    paymentTermsDays: integer(0, 365).nullable().optional(),
    billOn: z.enum(BILL_ON).nullable().optional(),
    shortageOnInvoice: z.enum(SHORTAGE_ON_INVOICE).nullable().optional(),
    revaluation: z.enum(REVALUATION).nullable().optional(),
    ageingBucketsDays: z.array(integer(1, 3650)).min(1).max(6)
      .refine((d) => d.every((n, i) => i === 0 || n > d[i - 1]!), 'Each column must end later than the one before').nullable().optional(),
  }).optional(),
  version: z.number().int().min(0).optional(),
}).refine((v) => v.money || v.billing, 'Send at least one setting');

/* ---------- Invoices ---------- */

const page = { page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25) };

export const invoiceListQuery = z.strictObject({
  ...page,
  customerId: objectId.optional(),
  kind: z.enum(['invoice', 'credit_note']).optional(),
  status: z.enum(['draft', 'approved', 'cancelled']).optional(),
  open: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});
export type InvoiceListQuery = z.infer<typeof invoiceListQuery>;

export const unbilledQuery = z.strictObject({ ...page, customerId: objectId.optional() });
export type UnbilledQuery = z.infer<typeof unbilledQuery>;

/** Draft invoices from closed trips. Without trips, every closed trip not yet invoiced (for this customer). */
export const draftInvoicesSchema = z.strictObject({
  tripIds: z.array(objectId).min(1).max(200).optional(),
  customerId: objectId.optional(),
  date: day.optional(),
});
export type DraftInvoicesInput = z.infer<typeof draftInvoicesSchema>;

const lineInput = z.strictObject({
  kind: z.enum(['freight', 'minimum', 'shortage', 'other']).default('other'),
  description: text(200),
  qty: z.number().min(-1e9).max(1e9),
  unit: text(20).optional(),
  unitPriceMinor: z.number().int().min(-1e13).max(1e13),
  taxPercent: percent.optional(),
});

/** Changes to a draft: its date, terms, note, or its lines (sent whole). */
export const updateDraftSchema = z.strictObject({
  version: z.number().int().min(0),
  date: day.optional(),
  dueDate: day.optional(),
  currencyId: objectId.optional(),
  note: text(1000, 0).optional(),
  lines: z.array(lineInput.extend({ id: objectId.optional() })).min(1).max(200).optional(),
});
export type UpdateDraftInput = z.infer<typeof updateDraftSchema>;

export const versionBody = z.strictObject({ version: z.number().int().min(0) });
export const cancelInvoiceSchema = z.strictObject({ version: z.number().int().min(0), reason: text(500) });

export const creditNoteSchema = z.strictObject({
  date: day.optional(),
  reason: text(500),
  /** Credit the whole open amount, or these lines. */
  lines: z.array(lineInput).min(1).max(50).optional(),
});
export type CreditNoteInput = z.infer<typeof creditNoteSchema>;

/* ---------- Payments received ---------- */

export const paymentListQuery = z.strictObject({ ...page, customerId: objectId.optional() });
export type PaymentListQuery = z.infer<typeof paymentListQuery>;

export const receivePaymentSchema = z.strictObject({
  customerId: objectId,
  date: day,
  amount: z.strictObject({ amountMinor: z.number().int().min(1).max(1e13), currencyId: objectId }),
  paymentMethodId: objectId.optional(),
  reference: text(80).optional(),
  note: text(1000, 0).optional(),
  /** Of the payment, in the payment's currency. Without allocations, the oldest open invoices first. */
  allocations: z.array(z.strictObject({ invoiceId: objectId, amountMinor: z.number().int().min(1).max(1e13) })).max(100).optional(),
});
export type ReceivePaymentInput = z.infer<typeof receivePaymentSchema>;
