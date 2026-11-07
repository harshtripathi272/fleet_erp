/**
 * The scheduled service reminders: `npm run maintenance:remind` (compiled) or `npm run maintenance:remind:dev`.
 * A scheduler starts it every hour (on Google Cloud, a Cloud Run job started by Cloud Scheduler; see
 * docs/deploy-gcp.md), because a service that scales to zero has no timer running while nobody uses it. It
 * fires "Service due" for what has come due, and reminds about documents expiring or expired (#105), sends those
 * messages, and exits. Exit code 1 when the run failed.
 */
import { connectMongo, disconnectMongo } from '../core/db/mongo.js';
import { logger } from '../core/logger/index.js';
import { refreshRegional } from '../modules/company/regional.js';
import { remindDueServices } from '../modules/maintenance/maintenance.service.js';
import { remindExpiringDocuments } from '../modules/compliance/expiryReminders.js';
// Loading the app registers every master, which the document reminders look through for company fields.
import '../app.js';
import { settleSends } from '../modules/messaging/dispatcher.js';

await connectMongo();
// Its messages use the company's formats, like the server's.
await refreshRegional();
let failed = false;
try {
  const reminded = await remindDueServices();
  const documents = await remindExpiringDocuments();
  // The messages go in the background: wait for them, or the process would end first.
  await settleSends();
  logger.info({ reminded, documents }, 'Service and document reminder run finished');
} catch (err) {
  failed = true;
  logger.error({ err }, 'Service reminder run crashed');
} finally {
  await disconnectMongo();
}
process.exit(failed ? 1 : 0);
