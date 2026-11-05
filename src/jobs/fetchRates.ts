/**
 * The scheduled exchange-rate fetch: `npm run rates:fetch` (compiled) or `npm run rates:fetch:dev`.
 * A scheduler starts it every hour (on Google Cloud, a Cloud Run job started by Cloud Scheduler; see
 * docs/deploy-gcp.md). It fetches only when due: after the company's fetch time, until a fetch that day
 * succeeds. `--now` fetches regardless. Exit code 1 when a fetch failed, so the scheduler shows it.
 */
import { connectMongo, disconnectMongo } from '../core/db/mongo.js';
import { logger } from '../core/logger/index.js';
import { refreshRegional } from '../modules/company/regional.js';
import { fetchIsDue, fetchRates } from '../modules/finance/rateFeed.service.js';

await connectMongo();
// Its messages use the company's formats, like the server's.
await refreshRegional();
let failed = false;
try {
  const due = process.argv.includes('--now') ? { due: true, reason: 'Asked to fetch now' } : await fetchIsDue();
  if (!due.due) {
    logger.info({ reason: due.reason }, 'Rate feed: nothing to do');
    await disconnectMongo();
    process.exit(0);
  }
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
