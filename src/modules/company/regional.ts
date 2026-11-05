import { REGIONAL_DEFAULTS, setRegional, type Regional } from '../../core/format/regional.js';
import { Country } from '../geography/models/country.model.js';
import { Company } from './company.model.js';

/**
 * The company's effective regional settings (#72): what it chose, else what its country implies (the
 * country's first time zone and its dialling code), else neutral defaults. Loaded into the formatter
 * (core/format/regional.ts) at start-up and after every save of the company.
 */
export async function effectiveRegional(): Promise<Regional> {
  const company = await Company.findOne().select('countryId timezone dateFormat fiscalYearStartMonth regional').lean<Record<string, any>>();
  const country = company?.countryId ? await Country.findById(company.countryId).select('dialCode timezones').lean<{ dialCode?: string; timezones?: string[] }>() : null;
  const chosen = (company?.regional ?? {}) as Partial<Regional>;
  const defined = <T>(v: T | undefined | null, fallback: T) => (v === undefined || v === null || v === '' ? fallback : v);
  return {
    timeZone: defined(company?.timezone, country?.timezones?.[0] ?? REGIONAL_DEFAULTS.timeZone),
    dateFormat: defined(company?.dateFormat, REGIONAL_DEFAULTS.dateFormat),
    fiscalYearStartMonth: defined(company?.fiscalYearStartMonth, REGIONAL_DEFAULTS.fiscalYearStartMonth),
    timeFormat: defined(chosen.timeFormat, REGIONAL_DEFAULTS.timeFormat),
    decimalSeparator: defined(chosen.decimalSeparator, REGIONAL_DEFAULTS.decimalSeparator),
    thousandsSeparator: chosen.thousandsSeparator ?? REGIONAL_DEFAULTS.thousandsSeparator,
    firstDayOfWeek: defined(chosen.firstDayOfWeek, REGIONAL_DEFAULTS.firstDayOfWeek),
    phoneCountryCode: defined(chosen.phoneCountryCode, country?.dialCode ?? REGIONAL_DEFAULTS.phoneCountryCode),
    unitSystem: defined(chosen.unitSystem, REGIONAL_DEFAULTS.unitSystem),
  };
}

/** Loads the company's settings into the formatter; returns them. */
export async function refreshRegional(): Promise<Regional> {
  const r = await effectiveRegional();
  setRegional(r);
  return r;
}
