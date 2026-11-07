import { Types } from 'mongoose';
import { z } from 'zod';
import { ValidationError } from '../../../core/errors/index.js';
import { defineMaster } from '../../../core/masters/define.js';
import { GROUPS } from '../../../core/masters/groups.js';
import { idQuery } from '../../../core/masters/query.js';
import type { Plain } from '../../../core/masters/types.js';
import { isAreaOn, requireArea } from '../../company/areas.js';
import { AccountCode, CustomerRate, POSTING_ROLES, RATE_BASES } from './billing.model.js';
import * as S from './billing.schema.js';

/** Billing is an area a company switches on (Company → Areas switched on); it starts off. */
export const isBillingOn = () => isAreaOn('billing');
export const requireBilling = requireArea('billing');

export const BASIS_LABELS: Record<(typeof RATE_BASES)[number], string> = {
  per_trip: 'Per trip', per_tonne: 'Per tonne', per_litre_20: 'Per litre at 20 °C', per_km: 'Per km (loaded)',
};

const byId = (path: string, description: string) => ({ schema: idQuery, apply: (v: string) => ({ [path]: new Types.ObjectId(v) }), description });

export const customerRateDefinition = defineMaster({
  key: 'customer-rates', label: 'Customer rates', singular: 'Customer rate', group: GROUPS.money, module: 'billing',
  description: 'What a customer pays to move a load: per trip, tonne, litre at 20 °C or km, for a route and product, between dates, with a minimum charge.',
  model: CustomerRate, createSchema: S.createCustomerRateSchema, updateSchema: S.updateCustomerRateSchema,
  sortFields: ['code', 'name', 'validFrom', 'createdAt', 'updatedAt'],
  refs: [
    { path: 'customerId', target: 'parties', partyRoles: ['customer'] }, { path: 'routeId', target: 'routes' }, { path: 'productId', target: 'products' },
    { path: 'price.currencyId', target: 'currencies' }, { path: 'minimumCharge.currencyId', target: 'currencies' },
  ],
  columns: ['customerId', 'routeId', 'productId', 'basis', 'price', 'validFrom'],
  labels: { customerId: 'Customer', routeId: 'Route', productId: 'Product', basis: 'Charged', price: 'Price', minimumCharge: 'Minimum charge', taxRatePercent: 'VAT %', validFrom: 'From', validTo: 'Until' },
  choiceLabels: { basis: BASIS_LABELS },
  hints: {
    routeId: 'Leave empty for every route. A rate for the trip\'s route wins over one without.',
    productId: 'Leave empty for every product. A rate for the trip\'s product wins over one without.',
    price: 'Per unit of what it is charged on: per trip, per tonne, per litre at 20 °C or per km driven loaded.',
    minimumCharge: 'The least a trip is charged, in the price\'s currency.',
    taxRatePercent: 'Used when Money settings put tax per customer or product. Empty: the customer\'s rate, then the company\'s.',
  },
  filters: {
    customerId: byId('customerId', 'Customer'),
    routeId: byId('routeId', 'Route'),
    basis: { schema: z.enum(RATE_BASES), apply: (v: string) => ({ basis: v }), description: 'How it is charged' },
  },
  async prepare(data: Plain) {
    const min = data.minimumCharge as { currencyId?: unknown } | undefined;
    const price = data.price as { currencyId?: unknown } | undefined;
    if (min && String(min.currencyId) !== String(price?.currencyId)) throw new ValidationError('The minimum charge must be in the price\'s currency', { minimumCharge: ['Use the price\'s currency'] });
    return data;
  },
});

export const POSTING_LABELS: Record<(typeof POSTING_ROLES)[number], string> = {
  receivables: 'Owed by customers', revenue: 'Freight income', tax: 'Tax collected', bank: 'Money received and paid out',
  exchange_gain: 'Exchange gains', exchange_loss: 'Exchange losses', unrealised_exchange: 'Unrealised exchange gain or loss',
  driver_advances: 'Cash advanced to drivers', expenses: 'Trip expenses',
};

export const accountCodeDefinition = defineMaster({
  key: 'account-codes', label: 'Account codes', singular: 'Account code', group: GROUPS.money, module: 'billing',
  description: "The company's own account codes, and which postings each takes in the accounting export: invoices, payments, exchange differences, driver advances and expenses.",
  model: AccountCode, createSchema: S.createAccountCodeSchema, updateSchema: S.updateAccountCodeSchema,
  columns: ['postsFor'],
  labels: { code: 'Account code', postsFor: 'Takes' },
  choiceLabels: { postsFor: POSTING_LABELS },
  hints: { code: "As in the company's accounts, e.g. 1100.", postsFor: 'Each posting goes to one account code. The export refuses until every posting it needs has one.' },
  async prepare(data: Plain, ctx) {
    const roles = (data.postsFor ?? []) as string[];
    if (!roles.length || data.status === 'inactive') return data;
    const taken = await AccountCode.findOne({ _id: { $ne: ctx.id }, status: 'active', postsFor: { $in: roles } }).select('code postsFor').lean() as Plain | null;
    if (taken) {
      const clash = roles.filter((r) => (taken.postsFor as string[]).includes(r)).map((r) => POSTING_LABELS[r as keyof typeof POSTING_LABELS]);
      throw new ValidationError(`${clash.join(', ')} already go${clash.length > 1 ? '' : 'es'} to account ${taken.code}`, { postsFor: ['Each posting goes to one account code'] });
    }
    return data;
  },
});
