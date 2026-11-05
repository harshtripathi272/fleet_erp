/**
 * Asks the GPS connection's tracker service for positions (#60):  node dist/jobs/pollTrackers.js
 * For platforms that run the timed work as scheduled jobs (IN_PROCESS_JOBS=false), every minute or so.
 * Nothing happens unless the GPS connection in use is one that is asked, such as Traccar.
 */
import { connectMongo, disconnectMongo } from '../core/db/mongo.js';
import { logger } from '../core/logger/index.js';
import '../app.js';
import { pollTrackers } from '../modules/tracking/positions.service.js';

await connectMongo();
let failed = false;
try {
  const result = await pollTrackers();
  logger.info(result ?? { note: 'No GPS connection to ask' }, 'Tracker poll finished');
} catch (err) {
  failed = true;
  logger.error({ err }, 'Tracker poll crashed');
} finally {
  await disconnectMongo();
}
process.exit(failed ? 1 : 0);
