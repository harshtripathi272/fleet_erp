import { getMaster } from '../../core/masters/registry.js';
import { Company } from '../company/company.model.js';

/**
 * What a new company still needs before its first trip (issue #45), for the "Set up the company" page.
 * Each check counts active records of a master; `required` ones block a first trip, the rest make it better
 * (distances and budgets, stages, the team). Masters named here are the screens the page links to.
 */
interface Check { key: string; label: string; why: string; master?: string; min: number; required: boolean; filter?: Record<string, unknown> }

/** Checked before the company details: the base currency is picked from these. */
const FIRST: Check[] = [
  { key: 'currencies', label: 'Currencies', why: 'The base currency of the books, and any other currency the company is paid or pays in.', master: 'currencies', min: 1, required: true },
];
const CHECKS: Check[] = [
  { key: 'countries', label: 'Countries and cities', why: 'Where places are; also each country\'s ID types and currency.', master: 'countries', min: 1, required: false },
  { key: 'places', label: 'Places', why: 'Depots, ports, customers\' sites: where trips start, load and offload.', master: 'places', min: 2, required: true },
  { key: 'customers', label: 'Customers', why: 'Every trip is for a customer.', master: 'parties', min: 1, required: true, filter: { roles: 'customer' } },
  { key: 'vehicle-types', label: 'Vehicle types', why: 'Each truck has a type (and its fuel use).', master: 'vehicle-types', min: 1, required: true },
  { key: 'vehicles', label: 'Trucks', why: 'The trucks that run trips.', master: 'vehicles', min: 1, required: true },
  { key: 'drivers', label: 'Drivers', why: 'Each trip has a driver.', master: 'drivers', min: 1, required: true },
  { key: 'payment-methods', label: 'Payment methods', why: 'How fuel and cash reach a driver: cash, mobile money, fuel card…', master: 'payment-methods', min: 1, required: true },
  { key: 'routes', label: 'Routes', why: 'Distances, fuel and cash budgets come from routes.', master: 'routes', min: 1, required: false },
  { key: 'products', label: 'Products', why: 'What is carried; fuel products get the 20 °C reconciliation.', master: 'products', min: 1, required: false },
  { key: 'trip-types', label: 'Default trip type', why: 'The stages a trip goes through.', master: 'trip-types', min: 1, required: false, filter: { isDefault: true } },
  { key: 'trailers', label: 'Trailers', why: 'Only if trucks pull trailers.', master: 'trailers', min: 1, required: false },
  { key: 'trip-budgets', label: 'Trip budgets', why: 'Cash per route; otherwise each trip is budgeted by hand.', master: 'trip-budgets', min: 1, required: false },
  { key: 'users', label: 'Your team', why: 'Invite Operations and Finance (one person can do everything to start).', master: 'users', min: 2, required: false },
];

export async function readiness() {
  const company = await Company.findOne().select('legalName baseCurrencyId timezone countryId').lean<{ legalName?: string; baseCurrencyId?: unknown; timezone?: string; countryId?: unknown }>();
  // The time zone is the company's own or its country's (Company → Regional settings).
  const companyDone = Boolean(company?.legalName && company.baseCurrencyId && (company.timezone || company.countryId));
  const count = async (c: Check) => {
    const def = c.master ? getMaster(c.master) : undefined;
    return def ? def.model.countDocuments({ status: 'active', ...(c.filter ?? {}) }) : 0;
  };
  const checks: { key: string; label: string; why: string; master?: string; required: boolean; count: number; min: number; done: boolean }[] = [];
  for (const c of FIRST) { const n = await count(c); checks.push({ key: c.key, label: c.label, why: c.why, master: c.master, required: c.required, count: n, min: c.min, done: n >= c.min }); }
  checks.push({
    key: 'company', label: 'Company details', why: 'Name, base currency and time zone: money and dates depend on them.', master: undefined, required: true,
    count: companyDone ? 1 : 0, min: 1, done: companyDone,
  });
  for (const c of CHECKS) { const n = await count(c); checks.push({ key: c.key, label: c.label, why: c.why, master: c.master, required: c.required, count: n, min: c.min, done: n >= c.min }); }
  const missing = checks.filter((c) => c.required && !c.done);
  return { ready: missing.length === 0, missing: missing.map((c) => c.label), checks };
}
