/**
 * The revenue engine (#130, consignments design 3.5): `priceConsignment(facts, tariff, settings)` works out what a
 * consignment is worth and why. The freight module's adapter gathers the facts and matches the tariff; this module
 * only computes, so every rule is tested as a table of facts in and lines out (`tests/revenue-engine.test.ts`).
 */
export { priceConsignment, roundMinor } from './engine.js';
export { checkTariff } from './checkTariff.js';
export { amountsOf, chargeableKg, chargedQuantity, losses, progress } from './quantities.js';
export { FORMULA_VARIABLES, formulaNames, sampleVariables, variablesFor } from './variables.js';
export * from './types.js';
