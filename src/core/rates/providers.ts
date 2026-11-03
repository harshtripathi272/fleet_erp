/**
 * Where daily exchange rates come from. Each provider answers one question: how many units of each
 * currency make one unit of the company's base currency, today. Which provider a company uses is a
 * setting (exchange-rates feed); the API key is a secret from the environment, never stored or returned.
 */
export interface RateAnswer {
  /** Units of each currency code per 1 unit of the base currency. */
  perBase: Record<string, number>;
  /** When the provider says its rates were taken. */
  asOf: Date;
}

export interface RateProvider {
  key: string;
  label: string;
  needsKey: boolean;
  fetch(input: { base: string; codes: string[]; apiKey?: string; signal?: AbortSignal }): Promise<RateAnswer>;
}

/**
 * Open Exchange Rates (openexchangerates.org): rates for about 170 currencies, including ZMW, TZS and CDF.
 * Its free plan quotes against USD only, so a ZMW-based answer is derived from the same USD quotes:
 * units of X per ZMW = (X per USD) / (ZMW per USD).
 */
const openExchangeRates: RateProvider = {
  key: 'openexchangerates',
  label: 'Open Exchange Rates',
  needsKey: true,
  async fetch({ base, codes, apiKey, signal }) {
    const symbols = [...new Set([base, ...codes, 'USD'])].join(',');
    const url = `https://openexchangerates.org/api/latest.json?app_id=${encodeURIComponent(apiKey ?? '')}&symbols=${encodeURIComponent(symbols)}`;
    const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
    const body = (await res.json().catch(() => ({}))) as { rates?: Record<string, number>; timestamp?: number; description?: string; message?: string };
    if (!res.ok || !body.rates) throw new Error(`Open Exchange Rates answered ${res.status}: ${body.description ?? body.message ?? 'no rates'}`);
    const usd = body.rates;
    const basePerUsd = base === 'USD' ? 1 : usd[base];
    if (!basePerUsd) throw new Error(`Open Exchange Rates has no rate for ${base}`);
    const perBase: Record<string, number> = {};
    for (const code of codes) {
      const perUsd = code === 'USD' ? 1 : usd[code];
      if (perUsd) perBase[code] = perUsd / basePerUsd;
    }
    return { perBase, asOf: body.timestamp ? new Date(body.timestamp * 1000) : new Date() };
  },
};

const providers = new Map<string, RateProvider>([[openExchangeRates.key, openExchangeRates]]);

/** The providers a company can pick, besides "manual" (no feed). */
export const RATE_PROVIDERS = [...providers.keys()];
export const rateProvider = (key: string) => providers.get(key);
export const listRateProviders = () => [...providers.values()].map((p) => ({ key: p.key, label: p.label, needsKey: p.needsKey }));

/** Tests replace a provider with a fake that answers without the network. */
export function setRateProvider(provider: RateProvider) {
  providers.set(provider.key, provider);
}
