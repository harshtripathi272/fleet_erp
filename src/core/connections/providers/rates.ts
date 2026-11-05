import { z } from 'zod';
import { registerProvider } from '../registry.js';
import { callJson } from './http.js';

/*
 * Exchange-rate feeds. Each answers one question: how many units of each currency make one unit of the
 * company's base currency, today. Which currencies and when to fetch stay on the exchange-rates screen.
 */

/**
 * Open Exchange Rates (openexchangerates.org): about 170 currencies, including ZMW, TZS and CDF. Its free
 * plan quotes against USD only, so a ZMW-based answer is derived: units of X per ZMW = (X per USD) / (ZMW per USD).
 */
registerProvider({
  kind: 'rates', key: 'openexchangerates', label: 'Open Exchange Rates',
  description: 'Daily rates for about 170 currencies. The free plan is enough.',
  fields: z.strictObject({}),
  secrets: [{ key: 'apiKey', label: 'App ID', required: true, hint: 'From openexchangerates.org → App IDs' }],
  async test(ctx) {
    const body = await callJson<{ rates?: Record<string, number> }>('Open Exchange Rates', `https://openexchangerates.org/api/latest.json?app_id=${encodeURIComponent(ctx.secret('apiKey')!)}`);
    const count = Object.keys(body.rates ?? {}).length;
    return { ok: count > 0, message: count ? `Answered with rates for ${count} currencies.` : 'Answered, but without any rates.' };
  },
  open: (ctx) => ({
    async fetch({ base, codes, signal }) {
      const symbols = [...new Set([base, ...codes, 'USD'])].join(',');
      const body = await callJson<{ rates?: Record<string, number>; timestamp?: number }>('Open Exchange Rates',
        `https://openexchangerates.org/api/latest.json?app_id=${encodeURIComponent(ctx.secret('apiKey') ?? '')}&symbols=${encodeURIComponent(symbols)}`, { signal });
      const usd = body.rates;
      if (!usd) throw new Error('Open Exchange Rates answered without rates');
      const basePerUsd = base === 'USD' ? 1 : usd[base];
      if (!basePerUsd) throw new Error(`Open Exchange Rates has no rate for ${base}`);
      const perBase: Record<string, number> = {};
      for (const code of codes) {
        const perUsd = code === 'USD' ? 1 : usd[code];
        if (perUsd) perBase[code] = perUsd / basePerUsd;
      }
      return { perBase, asOf: body.timestamp ? new Date(body.timestamp * 1000) : new Date() };
    },
  }),
});

/** Sample rates against one US dollar, for trying the feed out. Not real rates. */
const SAMPLE_PER_USD: Record<string, number> = { USD: 1, ZMW: 26.5, TZS: 2650, CDF: 2850, ZAR: 18.2, EUR: 0.92, GBP: 0.79, KES: 129, MWK: 1735, BWP: 13.6, MZN: 63.9 };

registerProvider({
  kind: 'rates', key: 'simulated', label: 'Simulated', simulated: true,
  description: 'Fixed sample rates, the same every day, for trying the feed. Never use them for real money.',
  fields: z.strictObject({}),
  test: async () => ({ ok: true, message: 'Sample rates are ready. They are not real rates.' }),
  open: () => ({
    async fetch({ base, codes }) {
      const basePerUsd = SAMPLE_PER_USD[base];
      if (!basePerUsd) throw new Error(`The sample rates have no ${base}`);
      const perBase: Record<string, number> = {};
      for (const code of codes) if (SAMPLE_PER_USD[code]) perBase[code] = SAMPLE_PER_USD[code]! / basePerUsd;
      return { perBase, asOf: new Date() };
    },
  }),
});
