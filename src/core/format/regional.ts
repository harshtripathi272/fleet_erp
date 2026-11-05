/**
 * The one place the server writes dates, times, numbers and amounts for people to read (#72): messages,
 * printouts, PDFs and refusals. It follows the company's regional settings (Company → Regional settings),
 * held here once loaded so formatting stays synchronous; the company module refreshes them on start-up and
 * whenever they are saved. Nothing here assumes a country, a currency or a clock.
 */

export const DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'] as const;
export const TIME_FORMATS = ['24h', '12h'] as const;
export const DECIMAL_SEPARATORS = ['.', ','] as const;
export const THOUSANDS_SEPARATORS = [',', '.', ' ', "'", ''] as const;
export const WEEK_STARTS = ['monday', 'sunday', 'saturday'] as const;
export const UNIT_SYSTEMS = ['metric', 'imperial'] as const;

export interface Regional {
  timeZone: string;
  dateFormat: (typeof DATE_FORMATS)[number];
  timeFormat: (typeof TIME_FORMATS)[number];
  decimalSeparator: (typeof DECIMAL_SEPARATORS)[number];
  thousandsSeparator: (typeof THOUSANDS_SEPARATORS)[number];
  firstDayOfWeek: (typeof WEEK_STARTS)[number];
  fiscalYearStartMonth: number;
  /** The default country code for phone numbers, e.g. +255. Empty when the company has no country. */
  phoneCountryCode: string;
  unitSystem: (typeof UNIT_SYSTEMS)[number];
}

/** What a company with no settings and no country gets: nothing about any one country. */
export const REGIONAL_DEFAULTS: Regional = {
  timeZone: 'UTC', dateFormat: 'DD/MM/YYYY', timeFormat: '24h', decimalSeparator: '.', thousandsSeparator: ',',
  firstDayOfWeek: 'monday', fiscalYearStartMonth: 1, phoneCountryCode: '', unitSystem: 'metric',
};

let current: Regional = { ...REGIONAL_DEFAULTS };
export const regional = (): Regional => current;
export const setRegional = (next: Partial<Regional>) => { current = { ...REGIONAL_DEFAULTS, ...next }; };

/* ---------- Numbers ---------- */

/** A number with the company's separators: 12,500.5 or 12.500,5 or 12 500,5. */
export function number(value: number, digits: { min?: number; max?: number } | number = 0, r: Regional = current): string {
  const { min, max } = typeof digits === 'number' ? { min: digits, max: digits } : { min: digits.min ?? 0, max: digits.max ?? digits.min ?? 0 };
  // `|| 0` turns -0 into 0, so it never shows as "-0".
  const plain = new Intl.NumberFormat('en-US', { minimumFractionDigits: min, maximumFractionDigits: Math.max(min, max), useGrouping: true }).format(value || 0);
  return plain.replace(/[,.]/g, (c) => (c === ',' ? '\u0001' : '\u0002')).replace(/\u0001/g, r.thousandsSeparator).replace(/\u0002/g, r.decimalSeparator);
}

/** An amount in minor units with its currency: "1,250.5 TZS". Trailing zeros are dropped, as messages always have. */
export const money = (amountMinor: number, currency: { code: string; minorUnits: number }, r: Regional = current) =>
  `${number(amountMinor / 10 ** currency.minorUnits, { min: 0, max: currency.minorUnits }, r)} ${currency.code}`;

/** An amount with all its decimals, for a template's {{amount}}: "1,250.50". */
export const amount = (amountMinor: number, minorUnits: number, r: Regional = current) => number(amountMinor / 10 ** minorUnits, minorUnits, r);

/* ---------- Dates and times ---------- */

function parts(date: Date, timeZone: string) {
  const zone = safeZone(timeZone);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(date).map((x) => [x.type, x.value]));
  return { y: p.year!, m: p.month!, d: p.day!, h: Number(p.hour) % 24, min: p.minute! };
}

function safeZone(zone: string) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return zone; } catch { return 'UTC'; }
}

/** A day in the company's time zone and date format: 05/11/2026, 11/05/2026 or 2026-11-05. */
export function date(value: Date | string | number, r: Regional = current): string {
  const { y, m, d } = parts(new Date(value), r.timeZone);
  return r.dateFormat === 'YYYY-MM-DD' ? `${y}-${m}-${d}` : r.dateFormat === 'MM/DD/YYYY' ? `${m}/${d}/${y}` : `${d}/${m}/${y}`;
}

/** A day without its year, for short lines: 05/11, 11/05 or 11-05. */
export function shortDate(value: Date | string | number, r: Regional = current): string {
  const { m, d } = parts(new Date(value), r.timeZone);
  return r.dateFormat === 'YYYY-MM-DD' ? `${m}-${d}` : r.dateFormat === 'MM/DD/YYYY' ? `${m}/${d}` : `${d}/${m}`;
}

/** A time of day in the company's time zone: 15:56 or 3:56 pm. */
export function time(value: Date | string | number, r: Regional = current): string {
  const { h, min } = parts(new Date(value), r.timeZone);
  if (r.timeFormat === '12h') return `${h % 12 || 12}:${min} ${h < 12 ? 'am' : 'pm'}`;
  return `${String(h).padStart(2, '0')}:${min}`;
}

export const dateTime = (value: Date | string | number, r: Regional = current) => `${date(value, r)} ${time(value, r)}`;

/** A calendar day stored as midnight UTC (an invoice's date, a due date), written as that day whatever the time zone. */
export const calendarDate = (value: Date | string | number, r: Regional = current) => date(value, { ...r, timeZone: 'UTC' });

/** The calendar day of `at` in the company's time zone, as midnight UTC of that day (how dates without times are stored). */
export function companyDay(at: Date, r: Regional = current): Date {
  const { y, m, d } = parts(at, r.timeZone);
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
}

/** The time of day of `at` in the company's time zone, as "HH:MM" (24-hour), for comparing with a setting. */
export function clockTime(at: Date, r: Regional = current): string {
  const { h, min } = parts(at, r.timeZone);
  return `${String(h).padStart(2, '0')}:${min}`;
}

/** The first day of the financial year that `at` falls in, by the company's financial year start. */
export function financialYearStart(at: Date, r: Regional = current): Date {
  const day = companyDay(at, r);
  const startMonth = r.fiscalYearStartMonth - 1;
  const year = day.getUTCMonth() >= startMonth ? day.getUTCFullYear() : day.getUTCFullYear() - 1;
  return new Date(Date.UTC(year, startMonth, 1));
}
