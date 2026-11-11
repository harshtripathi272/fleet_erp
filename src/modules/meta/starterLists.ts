import { logger } from '../../core/logger/index.js';
import { getMaster } from '../../core/masters/registry.js';
import * as MasterService from '../../core/masters/service.js';
import type { Plain } from '../../core/masters/types.js';
import { Company } from '../company/company.model.js';
import { Country } from '../geography/models/country.model.js';
import { Role } from '../roles/role.model.js';
import { STARTER_CITIES, codeOf } from './starterCities.js';
import { ensureFreightLists } from '../freight/defaults.js';

/**
 * "Just the usual lists" (#116): what nearly every transport company uses, so a real company reaches its first
 * trip by adding only its own trucks, drivers, places and customers. Nothing made up: no trucks, drivers or
 * customers. Every record is an ordinary one the company can change or switch off. A record whose code is
 * already there is left alone, so this can run on a company that has some of these, or run twice.
 * Amounts and payment methods use the company's base currency; with none set yet, approvals are left out.
 */
export async function loadStarterLists(actorId?: string) {
  const ctx = { actorId, canSeeSensitive: true };
  const company = await Company.findOne().select('baseCurrencyId countryId').lean<{ baseCurrencyId?: unknown; countryId?: unknown }>();
  const currency = company?.baseCurrencyId ? String(company.baseCurrencyId) : undefined;
  const ids: Record<string, string> = {};
  const result = { created: 0, existing: 0, failed: [] as string[] };

  /** Creates the record unless one with the same code (or the same `match`) is there; returns its id either way. */
  const put = async (key: string, data: Plain, match: Plain = { code: data.code }) => {
    const def = getMaster(key);
    if (!def) return undefined;
    const ref = `${key}:${String(data.code ?? JSON.stringify(match))}`;
    try {
      const found = await def.model.findOne(match).collation({ locale: 'en', strength: 2 }).select('_id').lean<{ _id: unknown }>();
      if (found) { result.existing += 1; return (ids[ref] = String(found._id)); }
      const record = await MasterService.create(def, def.createSchema.parse(data) as Plain, ctx);
      result.created += 1;
      return (ids[ref] = String(record.id));
    } catch (err) {
      result.failed.push(`${def.label ?? key} ${String(data.name ?? data.code ?? '')}: ${(err as Error).message}`);
      return undefined;
    }
  };
  const withCurrency = currency ? { currencyIds: [currency] } : {};

  // How fuel and cash reach a driver.
  await put('payment-methods', { code: 'CASH', name: 'Cash', kind: 'cash', referenceRequired: false, ...withCurrency });
  await put('payment-methods', { code: 'MOBILE-MONEY', name: 'Mobile money', kind: 'mobile_money', referenceRequired: true, ...withCurrency });
  await put('payment-methods', { code: 'BANK', name: 'Bank transfer', kind: 'bank_transfer', referenceRequired: true, ...withCurrency });
  await put('payment-methods', { code: 'FUEL-CARD', name: 'Fuel card', kind: 'fuel_card', forFuel: true, forCash: false, referenceRequired: true, ...withCurrency });

  // Units of measure.
  const litre = await put('units', { code: 'L', name: 'Litre', symbol: 'L', dimension: 'volume', decimals: 0 });
  const kg = await put('units', { code: 'KG', name: 'Kilogram', symbol: 'kg', dimension: 'mass', decimals: 0 });
  const tonne = await put('units', { code: 'T', name: 'Tonne', symbol: 't', dimension: 'mass', decimals: 3 });
  await put('units', { code: 'KM', name: 'Kilometre', symbol: 'km', dimension: 'length', decimals: 0 });
  await put('units', { code: 'EA', name: 'Each', symbol: 'ea', dimension: 'count', decimals: 0 });
  if (tonne && kg) await put('unit-conversions', { fromUnitId: tonne, toUnitId: kg, factor: 1000 }, { fromUnitId: tonne, toUnitId: kg, productId: { $exists: false } });
  if (litre) await put('fuel-types', { code: 'DIESEL', name: 'Diesel', unitId: litre, densityKgPerL: 0.835 });

  // Documents: reminders only. Nothing blocks a trip until the company chooses to.
  await put('document-types', { code: 'ROAD-TAX', name: 'Road tax', appliesTo: 'vehicle', hasExpiryDate: true, reminderDaysBefore: 30, blocking: 'none' });
  await put('document-types', { code: 'FITNESS', name: 'Certificate of fitness', appliesTo: 'vehicle', hasExpiryDate: true, reminderDaysBefore: 30, blocking: 'none' });
  await put('document-types', { code: 'INSURANCE', name: 'Motor insurance', appliesTo: 'vehicle', hasExpiryDate: true, reminderDaysBefore: 30, blocking: 'none' });
  await put('document-types', { code: 'TRAILER-INS', name: 'Trailer insurance', appliesTo: 'trailer', hasExpiryDate: true, reminderDaysBefore: 30, blocking: 'none' });
  await put('document-types', { code: 'DL', name: 'Driving licence', appliesTo: 'driver', hasExpiryDate: true, reminderDaysBefore: 60, blocking: 'none' });
  await put('document-types', { code: 'PASSPORT', name: 'Passport', appliesTo: 'driver', hasExpiryDate: true, reminderDaysBefore: 90, blocking: 'none' });

  // Trailers: each needs a type, and a type says what it can carry (#102).
  await put('trailer-types', { code: 'TANKER', name: 'Fuel tanker', cargoKinds: ['liquid_bulk'], hasCompartments: true });
  await put('trailer-types', { code: 'FLATBED', name: 'Flatbed', cargoKinds: ['general', 'container', 'abnormal'] });
  await put('trailer-types', { code: 'TAUTLINER', name: 'Tautliner (curtain-sider)', cargoKinds: ['general'] });
  await put('trailer-types', { code: 'SIDE-TIPPER', name: 'Side tipper', cargoKinds: ['dry_bulk'] });
  await put('trailer-types', { code: 'BULKER', name: 'Dry bulk tanker (cement, flour)', cargoKinds: ['dry_bulk'] });
  await put('trailer-types', { code: 'SKELETAL', name: 'Skeletal (containers)', cargoKinds: ['container'] });
  await put('trailer-types', { code: 'LOWBED', name: 'Lowbed', cargoKinds: ['abnormal'] });
  await put('trailer-types', { code: 'REEFER', name: 'Refrigerated', cargoKinds: ['refrigerated'] });

  // The main towns of the company's country, each in its region (#102).
  const country = company?.countryId ? await Country.findById(company.countryId).select('code').lean<{ code: string }>() : null;
  for (const [name, region, lat, lng] of country ? STARTER_CITIES[country.code] ?? [] : []) {
    const provinceId = await put('provinces', { code: `${country!.code}-${codeOf(region)}`.slice(0, 32), name: region, countryId: String(company!.countryId) });
    if (provinceId) await put('cities', { code: `${country!.code}-${codeOf(name)}`.slice(0, 32), name, provinceId, location: { lat, lng } });
  }

  // Trucks: each needs a type and a make.
  await put('vehicle-types', { code: 'PRIME', name: 'Prime mover (horse)', category: 'prime_mover', towsTrailer: true });
  await put('vehicle-types', { code: 'RIGID', name: 'Rigid truck', category: 'rigid' });
  await put('vehicle-types', { code: 'TANKER', name: 'Rigid tanker', category: 'tanker_rigid' });
  await put('vehicle-types', { code: 'TIPPER', name: 'Tipper', category: 'tipper' });
  await put('vehicle-types', { code: 'LIGHT', name: 'Light vehicle', category: 'light_vehicle' });
  for (const [code, name] of [['SCANIA', 'Scania'], ['VOLVO', 'Volvo'], ['MAN', 'MAN'], ['MERCEDES', 'Mercedes-Benz'], ['DAF', 'DAF'], ['IVECO', 'Iveco'], ['ISUZU', 'Isuzu'], ['HINO', 'Hino'], ['SINOTRUK', 'Sinotruk (Howo)'], ['TATA', 'Tata'], ['FAW', 'FAW'], ['SHACMAN', 'Shacman']] as const) {
    await put('vehicle-makes', { code, name });
  }

  // What drivers spend on the road.
  const road = await put('expense-categories', { code: 'ROAD', name: 'Road and border' });
  const subsistence = await put('expense-categories', { code: 'SUBS', name: 'Subsistence', receiptRequired: false });
  const repairs = await put('expense-categories', { code: 'REPAIRS', name: 'Repairs on the road' });
  if (road) {
    await put('expense-items', { code: 'TOLL', name: 'Road toll', categoryId: road, per: 'occurrence' });
    await put('expense-items', { code: 'BORDER-FEE', name: 'Border clearing fee', categoryId: road, per: 'border' });
    await put('expense-items', { code: 'PARKING', name: 'Parking', categoryId: road, per: 'occurrence' });
    await put('expense-items', { code: 'WEIGHBRIDGE', name: 'Weighbridge', categoryId: road, per: 'occurrence' });
  }
  if (subsistence) await put('expense-items', { code: 'MEALS', name: 'Meals and lodging', categoryId: subsistence, per: 'day', receiptRequired: false });
  if (repairs) {
    await put('expense-items', { code: 'PUNCTURE', name: 'Puncture repair', categoryId: repairs, per: 'occurrence' });
    await put('expense-items', { code: 'REPAIR', name: 'Breakdown repair', categoryId: repairs, per: 'occurrence' });
  }

  // Codes for drivers and customers, and trip numbers. One series per thing numbered.
  await put('numbering-series', { code: 'DRIVERS', name: 'Driver codes', entity: 'drivers', prefix: 'DRV', pattern: '{PREFIX}-{SEQ}', padding: 4, resetPolicy: 'never' }, { entity: 'drivers', branchId: { $exists: false } });
  await put('numbering-series', { code: 'PARTIES', name: 'Customer and supplier codes', entity: 'parties', prefix: 'PTY', pattern: '{PREFIX}-{SEQ}', padding: 4, resetPolicy: 'never' }, { entity: 'parties', branchId: { $exists: false } });
  await put('numbering-series', { code: 'TRIPS', name: 'Trip numbers', entity: 'trips', prefix: 'TRIP', pattern: '{PREFIX}/{YY}/{SEQ}', padding: 4, resetPolicy: 'yearly' }, { entity: 'trips', branchId: { $exists: false } });

  // Who approves money and fuel: Finance, in the app or on WhatsApp. One level; add more as the company grows.
  // What's carried: one general product, so a load can be recorded from day one. Rename it, or add the company's own.
  const goods = await put('product-groups', { code: 'GENERAL', name: 'General goods' });
  if (goods && tonne) await put('products', { code: 'GENERAL', name: 'General cargo', groupId: goods, unitId: tonne });

  // Freight (#135): kinds of consignment, the papers that go with them, and the kinds of money line on a bill.
  result.created += await ensureFreightLists(actorId);

  const finance = await Role.findOne({ key: 'finance' }).select('_id').lean<{ _id: unknown }>();
  if (currency && finance) {
    const approver = String(finance._id);
    await put('approval-policies', { code: 'CASH-ADVANCE', name: 'Cash advances', subject: 'cash_advance', currencyId: currency, levels: [{ level: 1, minAmountMinor: 0, approverRoleId: approver, channels: ['app', 'whatsapp'] }] }, { subject: 'cash_advance' });
    await put('approval-policies', { code: 'FUEL', name: 'Fuel requests', subject: 'fuel_request', currencyId: currency, levels: [{ level: 1, minAmountMinor: 0, measure: 'litres', approverRoleId: approver, channels: ['app', 'whatsapp'] }] }, { subject: 'fuel_request' });
    await put('approval-policies', { code: 'EXPENSES', name: 'Driver expenses', subject: 'expense', currencyId: currency, levels: [{ level: 1, minAmountMinor: 0, approverRoleId: approver, channels: ['app'] }] }, { subject: 'expense' });
  } else if (!currency) result.failed.push('Approvals: set the company\'s base currency first, then add the usual lists again.');

  logger.info({ ...result, failed: result.failed.length }, 'Starter lists loaded');
  return result;
}
