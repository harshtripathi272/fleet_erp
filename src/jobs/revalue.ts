/**
 * The scheduled revaluation of open foreign-currency invoices (#62): `npm run billing:revalue` (compiled) or
 * `npm run billing:revalue:dev`. A scheduler starts it once a day, like rates:fetch (docs/deploy-gcp.md); it
 * revalues only when Money settings say monthly or quarterly and the last period end has no run yet.
 * Exit code 1 when the run failed, so the scheduler shows it.
 */
import { connectMongo, disconnectMongo } from '../core/db/mongo.js';
import { logger } from '../core/logger/index.js';
import { revaluationDue, revalue } from '../modules/finance/billing/revaluation.service.js';

await connectMongo();
let failed = false;
try {
  const due = await revaluationDue();
  if (!due.due) {
    logger.info({ reason: due.reason }, 'Revaluation: nothing to do');
  } else {
    const run = await revalue({ periodEnd: due.periodEnd, trigger: 'schedule' }, { name: 'Scheduler', desk: 'finance', can: () => true, roles: [] });
    logger.info({ periodEnd: run.periodEnd, invoices: run.invoices, netMinor: run.netMinor, reversedMinor: run.reversedMinor, missing: run.missing }, 'Revaluation finished');
  }
} catch (err) {
  failed = true;
  logger.error({ err }, 'Revaluation failed');
} finally {
  await disconnectMongo();
}
process.exit(failed ? 1 : 0);
