/**
 * The profile library (platform design §5.1): the company file's schema in both formats, environments,
 * migration between formats, checking, the kit, the deploy guide, and the folder a company is kept in.
 *
 * Imported by the fleet CLI, Fleet Studio and the Runtime. It imports neither the server's settings
 * (src/config/env.ts) nor Mongoose itself, and opens no database: it validates against the app's own
 * registries (masters, connection providers, areas), which come with the modules it names.
 */
export * from './schema.js';
export * from './environment.js';
export * from './migrate.js';
export * from './check.js';
export * from './folder.js';
export { type Copy, TARGET_LABEL, TARGET_STATE, TESTED_TARGETS, appSource, buildKit, checkKit, envTemplate, kitEntries, kitName } from './kit.js';
export { TARGET_FIELDS, TARGET_NEEDS, type TargetField, deployGuide, envVars, guideSteps } from './guide.js';
export { readCsv } from './csv.js';
export { type ZipEntry, unzip, zip } from './zip.js';
