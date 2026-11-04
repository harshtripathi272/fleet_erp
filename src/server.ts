import { app } from './app.js';
import { env } from './config/env.js';
import { connectRedis, disconnectRedis } from './core/cache/redis.js';
import { connectMongo, disconnectMongo, syncIndexes } from './core/db/mongo.js';
import { logger } from './core/logger/index.js';
import { ensureFirstOwner } from './modules/auth/auth.service.js';
import { ensureBillingMessages, ensureDefaultMessages } from './modules/messaging/defaults.js';
import { settleSends, startOutboxWorker, stopOutboxWorker } from './modules/messaging/dispatcher.js';
import { ensureSystemRoles } from './modules/roles/roles.service.js';

await connectMongo();
await syncIndexes();
await ensureSystemRoles();
await ensureFirstOwner();
// A new installation starts with the default message templates and rules, once (#43).
await ensureDefaultMessages();
await ensureBillingMessages();
await connectRedis();
// Retries and delayed messages go out from here: only in the server, so scripts and tests that load the app don't start it.
startOutboxWorker();

const server = app.listen(env.PORT, env.HOST, () => {
  logger.info({ host: env.HOST, port: env.PORT, environment: env.NODE_ENV }, 'Server started');
  if (env.CONSOLE_ENABLED) logger.info({ url: `http://${env.HOST}:${env.PORT}/console/` }, 'API test console available');
});

let stopping = false;
function shutdown(reason: string, exitCode: number) {
  process.exitCode = Math.max(Number(process.exitCode ?? 0), exitCode);
  if (stopping) return;
  stopping = true;
  logger.info({ reason }, 'Draining requests before shutdown');
  const timer = setTimeout(() => {
    logger.fatal({}, 'Shutdown deadline exceeded');
    server.closeAllConnections();
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);
  timer.unref();
  server.close(async (err) => {
    clearTimeout(timer);
    if (err) { logger.error({ err }, 'Shutdown failed'); process.exitCode = 1; }
    stopOutboxWorker();
    await settleSends();
    await Promise.allSettled([disconnectMongo(), disconnectRedis()]);
    logger.info({}, 'Server stopped');
    logger.flush();
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM', 0));
process.on('SIGINT', () => shutdown('SIGINT', 0));
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (err) => {
  logger.fatal({ err }, 'Unhandled rejection');
  shutdown('unhandledRejection', 1);
});
server.on('error', (err) => {
  logger.fatal({ err }, 'Server failed');
  process.exitCode = 1;
});
