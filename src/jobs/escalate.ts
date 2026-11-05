/**
 * The scheduled escalation run: `npm run approvals:escalate` (compiled) or `npm run approvals:escalate:dev`.
 * A scheduler starts it every 15 minutes (on Google Cloud, a Cloud Run job started by Cloud Scheduler; see
 * docs/deploy-gcp.md), because a service that scales to zero overnight has no timer running when requests
 * wait longest. It moves up what has waited too long, sends what that move tells people, and exits.
 * Exit code 1 when the run failed, so the scheduler shows it.
 */
import { connectMongo, disconnectMongo } from '../core/db/mongo.js';
import { logger } from '../core/logger/index.js';
import { refreshRegional } from '../modules/company/regional.js';
import { settleSends } from '../modules/messaging/dispatcher.js';
import { escalateDue } from '../modules/operations/escalation.js';

await connectMongo();
// Its messages use the company's formats, like the server's.
await refreshRegional();
let failed = false;
try {
  const moved = await escalateDue();
  // The messages go in the background: wait for them, or the process would end first.
  await settleSends();
  logger.info({ moved }, 'Escalation run finished');
} catch (err) {
  failed = true;
  logger.error({ err }, 'Escalation run crashed');
} finally {
  await disconnectMongo();
}
process.exit(failed ? 1 : 0);
