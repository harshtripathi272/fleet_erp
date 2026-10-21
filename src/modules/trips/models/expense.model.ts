import { codeNameFields, uniqueIndex } from '../../../core/masters/define.js';
import { ObjectId, masterSchema, moneySchema, masterModel } from '../../../core/masters/schema.js';

export const EXPENSE_PER = ['trip', 'day', 'border', 'km', 'occurrence'] as const;

const expenseCategorySchema = masterSchema({
  ...codeNameFields,
  ledgerCode: String,
  receiptRequired: { type: Boolean, default: true },
  maxWithoutApproval: moneySchema,
});
uniqueIndex(expenseCategorySchema, { code: 1 });
export const ExpenseCategory = masterModel('ExpenseCategory', expenseCategorySchema);

const expenseItemSchema = masterSchema({
  ...codeNameFields,
  categoryId: { type: ObjectId, ref: 'ExpenseCategory', required: true, index: true },
  defaultAmount: moneySchema,
  per: { type: String, enum: EXPENSE_PER, default: 'occurrence' },
  /** Overrides the category when set. */
  receiptRequired: Boolean,
});
uniqueIndex(expenseItemSchema, { code: 1 });
export const ExpenseItem = masterModel('ExpenseItem', expenseItemSchema);
