import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, masterSchema, masterModel } from '../../../core/masters/schema.js';

export const PAYMENT_KINDS = ['cash', 'mobile_money', 'bank_transfer', 'fuel_card', 'fuel_voucher', 'own_depot', 'credit_account', 'cheque'] as const;

const paymentMethodSchema = masterSchema({
  ...codeNameFields,
  kind: { type: String, enum: PAYMENT_KINDS, required: true },
  provider: String,
  referenceRequired: { type: Boolean, default: true },
  currencyIds: { type: [{ type: ObjectId, ref: 'Currency' }], default: undefined },
  forFuel: { type: Boolean, default: false },
  forCash: { type: Boolean, default: true },
});
uniqueIndex(paymentMethodSchema, { code: 1 });

export const PaymentMethod = masterModel('PaymentMethod', paymentMethodSchema);
