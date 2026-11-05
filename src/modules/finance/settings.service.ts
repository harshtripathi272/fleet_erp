import { ConflictError, ValidationError } from '../../core/errors/index.js';
import { audit } from '../../core/masters/audit.js';
import { Company } from '../company/company.model.js';
import { Currency } from './models/currency.model.js';
import { BILLING_DEFAULTS, FinanceSettings, MONEY_DEFAULTS } from './models/financeSettings.model.js';

/**
 * Company → Money: how amounts are converted (every conversion, driver advances included) and how customers
 * are billed (#61). Unset values take the defaults in financeSettings.model.ts.
 */

export type MoneySettings = typeof MONEY_DEFAULTS;
export type BillingSettings = typeof BILLING_DEFAULTS;

const defined = (o: object | undefined) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined && v !== null));

async function stored() {
  return FinanceSettings.findById('finance').lean<{ money?: Partial<MoneySettings>; billing?: Partial<BillingSettings>; version?: number }>();
}

export async function moneySettings(): Promise<MoneySettings> {
  const doc = await stored();
  const money = { ...MONEY_DEFAULTS, ...defined(doc?.money) } as MoneySettings;
  return { ...money, pivotCurrencyId: money.pivotCurrencyId ? String(money.pivotCurrencyId) : undefined };
}

export async function billingSettings(): Promise<BillingSettings> {
  return { ...BILLING_DEFAULTS, ...defined((await stored())?.billing) } as BillingSettings;
}

/** The pivot currency's id: the one chosen, else USD; undefined when converting through a pivot is off or there is none. */
export async function pivotCurrency(settings?: MoneySettings): Promise<{ id: string; code: string } | undefined> {
  const s = settings ?? await moneySettings();
  if (!s.viaPivot) return undefined;
  const c = s.pivotCurrencyId
    ? await Currency.findById(s.pivotCurrencyId).select('code').lean()
    : await Currency.findOne({ code: 'USD', status: 'active' }).select('code').lean();
  return c ? { id: String(c._id), code: String(c.code) } : undefined;
}

export async function getSettings() {
  const [money, billing, doc] = await Promise.all([moneySettings(), billingSettings(), stored()]);
  const pivot = await pivotCurrency(money);
  return { money: { ...money, pivotCurrencyCode: pivot?.code ?? null }, billing, version: doc?.version ?? 0, defaults: { money: MONEY_DEFAULTS, billing: BILLING_DEFAULTS } };
}

export interface SaveSettingsInput { money?: Partial<MoneySettings> & { pivotCurrencyId?: string | null }; billing?: Partial<BillingSettings>; version?: number }

/** Saves only the settings sent; a null clears one back to its default. Sends the version edited, so a second editor isn't overwritten. */
export async function saveSettings(input: SaveSettingsInput, actorId?: string, requestId?: string) {
  if (input.money?.pivotCurrencyId && !(await Currency.exists({ _id: input.money.pivotCurrencyId, status: 'active' }))) {
    throw new ValidationError('Unknown currency', { 'money.pivotCurrencyId': ['No active currency with this id'] });
  }
  const doc = await stored();
  const version = doc?.version ?? 0;
  if (input.version !== undefined && input.version !== version) throw new ConflictError('Money settings were changed by someone else. Reload and try again.', { currentVersion: version });
  const set: Record<string, unknown> = {};
  const unset: Record<string, 1> = {};
  for (const part of ['money', 'billing'] as const) {
    for (const [key, value] of Object.entries(input[part] ?? {})) {
      if (value === undefined) continue;
      if (value === null) unset[`${part}.${key}`] = 1;
      else set[`${part}.${key}`] = value;
    }
  }
  const changed = [...Object.keys(set), ...Object.keys(unset)];
  if (!changed.length) return getSettings();
  const stale = () => new ConflictError('Money settings were changed by someone else. Reload and try again.');
  const result = await FinanceSettings.updateOne(
    { _id: 'finance', ...(doc ? { version } : {}) },
    { $set: { ...set, updatedBy: actorId }, ...(Object.keys(unset).length ? { $unset: unset } : {}), $inc: { version: 1 } },
    { upsert: !doc },
  ).catch((err) => {
    if ((err as { code?: number }).code === 11000) throw stale();
    throw err;
  });
  if (!result.matchedCount && !result.upsertedCount) throw stale();
  // The audit log files it under the company, like the other company settings.
  const company = await Company.findOne().select('_id').lean();
  if (company) await audit({ entity: 'company', entityId: company._id, action: 'update', summary: `Money settings changed: ${changed.join(', ')}`, actorId, requestId });
  return getSettings();
}
