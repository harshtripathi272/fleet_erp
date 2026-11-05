import { env } from '../../config/env.js';
import { ValidationError } from '../../core/errors/index.js';
import { logger } from '../../core/logger/index.js';
import { audit } from '../../core/masters/audit.js';
import { listRateProviders, rateProvider } from '../../core/rates/providers.js';
import { Company } from '../company/company.model.js';
import { effectiveRegional } from '../company/regional.js';
import * as Fmt from '../../core/format/regional.js';
import { Currency } from './models/currency.model.js';
import { ExchangeRate } from './models/exchangeRate.model.js';
import { RateFeedRun } from './models/rateFeedRun.model.js';

/**
 * The daily exchange-rate feed (issue #22). Rates are stored in the exchange-rates master as
 * "1 <currency> = rate <base currency>", with source "feed" and the day's date in the company's time zone.
 * A rate someone entered by hand or from the bank for that pair and day is never overwritten.
 */

export interface RateFeedSettings { provider: string; currencyIds: string[]; fetchAt: string }

const FETCH_TIMEOUT_MS = 20_000;

/** The calendar day of `at` in the company's time zone, as midnight UTC of that day (how rate dates are stored). */
export const companyDay = (at: Date, timeZone: string): Date => Fmt.companyDay(at, { ...Fmt.regional(), timeZone });

async function company() {
  return Company.findOne().select('baseCurrencyId timezone rateFeed').lean<{ baseCurrencyId?: unknown; timezone?: string; rateFeed?: { provider?: string; currencyIds?: unknown[]; fetchAt?: string } }>();
}

export async function feedSettings(): Promise<RateFeedSettings> {
  const c = await company();
  return { provider: c?.rateFeed?.provider ?? 'manual', currencyIds: (c?.rateFeed?.currencyIds ?? []).map(String), fetchAt: c?.rateFeed?.fetchAt ?? '06:00' };
}

/** What the exchange-rates screen shows: the setting, the providers, whether a key is set (never the key), the last runs. */
export async function feedStatus() {
  const [settings, runs, c] = await Promise.all([feedSettings(), RateFeedRun.find().sort({ at: -1 }).limit(10).lean(), company()]);
  return {
    ...settings,
    baseCurrencyId: c?.baseCurrencyId ? String(c.baseCurrencyId) : null,
    providers: [{ key: 'manual', label: 'Manual (no feed)', needsKey: false }, ...listRateProviders()],
    keyConfigured: Boolean(env.RATE_FEED_API_KEY),
    runs: runs.map(({ _id, ...r }) => ({ id: String(_id), ...r })),
  };
}

export async function saveFeedSettings(input: Partial<RateFeedSettings>, actorId?: string) {
  if (input.provider && input.provider !== 'manual' && !rateProvider(input.provider)) throw new ValidationError('Unknown rate provider', { provider: [`"${input.provider}" is not a provider`] });
  if (input.currencyIds?.length) {
    const found = await Currency.countDocuments({ _id: { $in: input.currencyIds } });
    if (found !== new Set(input.currencyIds).size) throw new ValidationError('Unknown currency', { currencyIds: ['One of the currencies does not exist'] });
  }
  const set = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined).map(([k, v]) => [`rateFeed.${k}`, v]));
  const doc = await Company.findOneAndUpdate({}, { $set: { ...set, updatedBy: actorId } }, { new: true });
  if (!doc) throw new ValidationError('Set up the company first (Company details).');
  await audit({ entity: 'company', entityId: doc._id, action: 'update', summary: 'Exchange-rate feed settings changed', actorId });
  return feedStatus();
}

/** The time of day of `at` in the company's time zone, as "HH:MM". */
const companyTime = (at: Date, timeZone: string) => Fmt.clockTime(at, { ...Fmt.regional(), timeZone });

/** The company's time zone: its own, else its country's (Company → Regional settings). */
const zoneOf = async () => (await effectiveRegional()).timeZone;

/**
 * Whether the scheduled fetch should run now. The scheduler starts the job every hour; the job fetches once a
 * day, after the company's fetch time, and tries again each hour until a fetch that day succeeds. So the
 * fetch time set on the screen is the only one, and a failure is retried without anyone acting.
 */
export async function fetchIsDue(now = new Date()) {
  const settings = await feedSettings();
  if (settings.provider === 'manual') return { due: false, reason: 'The feed is off (manual rates)' };
  const zone = await zoneOf();
  if (companyTime(now, zone) < settings.fetchAt) return { due: false, reason: `Before today's fetch time (${settings.fetchAt})` };
  const today = companyDay(now, zone);
  if (await RateFeedRun.exists({ outcome: 'stored', effectiveDate: today })) return { due: false, reason: "Today's rates are already stored" };
  return { due: true, reason: 'Due' };
}

/**
 * Fetches today's rates and stores them. Never throws for a provider failure: the run is recorded as failed,
 * yesterday's rates stay in place, and the screen shows the reason.
 */
export async function fetchRates(options: { now?: Date; trigger?: 'schedule' | 'manual'; actorId?: string } = {}) {
  const now = options.now ?? new Date();
  const trigger = options.trigger ?? 'schedule';
  const c = await company();
  const settings = await feedSettings();
  const record = (run: Record<string, unknown>) => RateFeedRun.create({ at: now, provider: settings.provider, trigger, ...run });
  if (settings.provider === 'manual') return record({ outcome: 'off' });
  const provider = rateProvider(settings.provider);
  if (!provider) return record({ outcome: 'failed', error: `Unknown provider "${settings.provider}"` });
  if (provider.needsKey && !env.RATE_FEED_API_KEY) return record({ outcome: 'failed', error: 'RATE_FEED_API_KEY is not set' });
  const base = c?.baseCurrencyId ? await Currency.findById(c.baseCurrencyId).select('code').lean() : null;
  if (!base) return record({ outcome: 'failed', error: 'The company has no base currency' });
  const wanted = await Currency.find(settings.currencyIds.length ? { _id: { $in: settings.currencyIds } } : { status: 'active' }).select('code').lean();
  const others = wanted.filter((x) => String(x._id) !== String(base._id));
  const effectiveDate = companyDay(now, await zoneOf());

  let answer;
  try {
    answer = await provider.fetch({ base: String(base.code), codes: others.map((x) => String(x.code)), apiKey: env.RATE_FEED_API_KEY, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    const error = (err as Error).name === 'TimeoutError' ? `${provider.label} did not answer within ${FETCH_TIMEOUT_MS / 1000} s` : (err as Error).message;
    logger.warn({ provider: provider.key, error }, 'Exchange-rate fetch failed; earlier rates stay in use');
    return record({ outcome: 'failed', effectiveDate, error });
  }

  let stored = 0;
  let keptManual = 0;
  const missing: string[] = [];
  for (const currency of others) {
    const perBase = answer.perBase[String(currency.code)];
    if (!perBase || !Number.isFinite(perBase) || perBase <= 0) { missing.push(String(currency.code)); continue; }
    // A rate typed in for this pair and day, in either direction, wins over the feed.
    const pair = { $or: [{ baseCurrencyId: currency._id, quoteCurrencyId: base._id }, { baseCurrencyId: base._id, quoteCurrencyId: currency._id }], effectiveDate };
    if (await ExchangeRate.exists({ ...pair, source: { $ne: 'feed' } })) { keptManual += 1; continue; }
    const rate = Number((1 / perBase).toPrecision(10));
    const existing = await ExchangeRate.findOne({ ...pair, source: 'feed' });
    if (existing) {
      // The model keeps `version` itself (optimistic locking), so a concurrent edit is refused, not lost.
      existing.set({ rate, baseCurrencyId: currency._id, quoteCurrencyId: base._id });
      await existing.save();
      await audit({ entity: 'exchange-rates', entityId: existing._id, action: 'update', summary: `Rate feed (${provider.label})`, actorId: options.actorId });
    } else {
      const created = await ExchangeRate.create({ baseCurrencyId: currency._id, quoteCurrencyId: base._id, rate, effectiveDate, source: 'feed', notes: `${provider.label}, ${answer.asOf.toISOString()}` });
      await audit({ entity: 'exchange-rates', entityId: created._id, action: 'create', summary: `Rate feed (${provider.label})`, actorId: options.actorId });
    }
    stored += 1;
  }
  logger.info({ provider: provider.key, stored, keptManual, missing }, 'Exchange rates fetched');
  return record({ outcome: 'stored', effectiveDate, stored, keptManual, missing });
}
