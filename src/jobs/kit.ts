/**
 * The company kit (#76):  npm run kit -- companies/acme/company.json [--out <folder>]
 *
 * Now `fleet kit` (src/cli/fleet.ts, #133), kept under its old name: it takes a format-1 company.json as before,
 * or a company folder with its profile and environments. Writes <company>-kit.zip; exit code 1, with every
 * problem listed, when it can't be built. Needs no database.
 */
import { main } from '../cli/fleet.js';

process.exit(await main(['kit', ...process.argv.slice(2)]));
