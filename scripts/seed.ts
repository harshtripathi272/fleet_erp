import '../src/app.js';
import { connectMongo, disconnectMongo, syncIndexes } from '../src/core/db/mongo.js';
import { logger } from '../src/core/logger/index.js';
import { settleSends } from '../src/modules/messaging/dispatcher.js';
import { loadSampleData } from '../src/modules/meta/sampleData.js';
import { ensureSystemRoles } from '../src/modules/roles/roles.service.js';

/** npm run seed — loads the sample operation into the database in MONGODB_URI. `npm run seed -- --small` loads only the masters. */
await connectMongo();
await syncIndexes();
await ensureSystemRoles();
try {
  const result = await loadSampleData(undefined, process.argv.includes('--small') ? 'small' : 'full');
  logger.info(result, 'Seed complete');
} catch (err) {
  logger.error({ err: (err as Error).message }, 'Seed skipped');
  process.exitCode = 1;
} finally {
  // The sample's trips queue messages that send in the background; they finish before the database closes.
  await settleSends();
  await disconnectMongo();
}
