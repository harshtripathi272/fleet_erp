/**
 * Fetches today's exchange rates once and exits: `npm run rates:fetch` (compiled) or `npm run rates:fetch:dev`.
 * A scheduler runs it daily at the company's fetch time; on Google Cloud, a Cloud Run job started by
 * Cloud Scheduler (see docs/deploy-gcp.md). Exit code 1 when the fetch failed, so the scheduler shows it.
 */
import { connectMongo, disconnectMongo } from '../core/db/mongo.js';
import { logger } from '../core/logger/index.js';
import { fetchRates } from '../modules/finance/rateFeed.service.js';

await connectMongo();
let failed = false;
try {
  const run = await fetchRates({ trigger: 'schedule' });
  failed = run.outcome === 'failed';
  logger.info({ outcome: run.outcome, stored: run.stored, keptManual: run.keptManual, missing: run.missing, error: run.error }, 'Rate feed run finished');
} catch (err) {
  failed = true;
  logger.error({ err }, 'Rate feed run crashed');
} finally {
  await disconnectMongo();
}
process.exit(failed ? 1 : 0);
