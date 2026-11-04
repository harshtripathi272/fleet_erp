import { Types } from 'mongoose';
import { z } from 'zod';
import { ValidationError } from '../../core/errors/index.js';
import { defineMaster } from '../../core/masters/define.js';
import { GROUPS } from '../../core/masters/groups.js';
import { idQuery } from '../../core/masters/query.js';
import type { MasterDefinition, Plain } from '../../core/masters/types.js';
import { OrderSource } from './models/orderSource.model.js';
import { PARTY_ROLES, Party } from './models/party.model.js';
import * as S from './parties.schema.js';

export const partyDefinition = defineMaster({
  key: 'parties', label: 'Parties', singular: 'Party', group: GROUPS.parties, lockedChoices: ['roles'],
  description: 'Every company or person you deal with: customers, consignors, consignees, suppliers, brokers, clearing agents, hired transporters. One record, many roles, one balance.',
  model: Party, createSchema: S.createPartySchema, updateSchema: S.updatePartySchema,
  searchFields: ['code', 'name', 'tradingName', 'taxId', 'contacts.name', 'contacts.email', 'contacts.phone'],
  autoCode: true,
  sensitive: ['bankAccounts.accountNumber'],
  refs: [
    { path: 'countryId', target: 'countries' }, { path: 'currencyId', target: 'currencies' },
    { path: 'creditLimit.currencyId', target: 'currencies' }, { path: 'addresses.cityId', target: 'cities' },
    { path: 'bankAccounts.currencyId', target: 'currencies' },
  ],
  filters: {
    role: { schema: z.enum(PARTY_ROLES), apply: (v: string) => ({ roles: v }), description: 'Parties holding this role' },
    countryId: { schema: idQuery, apply: (v: string) => ({ countryId: new Types.ObjectId(v) }), description: 'Country' },
  },
  async prepare(data: Plain) {
    const errors: Record<string, string[]> = {};
    const contacts = (data.contacts ?? []) as Array<{ isPrimary?: boolean; phone?: string; email?: string; whatsapp?: string; name: string }>;
    if (contacts.filter((c) => c.isPrimary).length > 1) (errors.contacts ??= []).push('Only one contact can be primary');
    contacts.forEach((c, i) => { if (!c.phone && !c.email && !c.whatsapp) (errors.contacts ??= []).push(`Contact ${i + 1}: give a phone, WhatsApp number or e-mail`); });
    const addresses = (data.addresses ?? []) as Array<{ kind: string; isDefault?: boolean }>;
    for (const kind of new Set(addresses.map((a) => a.kind))) {
      if (addresses.filter((a) => a.kind === kind && a.isDefault).length > 1) (errors.addresses ??= []).push(`Only one default ${kind} address`);
    }
    if (data.creditLimit && !(data.roles as string[]).includes('customer')) (errors.creditLimit ??= []).push('Only customers have a credit limit');
    if (data.taxId && !data.countryId) (errors.countryId ??= []).push('Set the country that issued the tax ID');
    if (Object.keys(errors).length) throw new ValidationError('Party details are not valid', errors);
    return data;
  },
});

export const orderSourceDefinition = defineMaster({
  key: 'order-sources', label: 'Order sources', singular: 'Order source', group: GROUPS.parties, module: 'trips',
  description: 'Where a job came from: direct, broker, tender, portal. Some require a reference number.',
  model: OrderSource, createSchema: S.createOrderSourceSchema, updateSchema: S.updateOrderSourceSchema,
});

export const masters: MasterDefinition[] = [partyDefinition, orderSourceDefinition];
