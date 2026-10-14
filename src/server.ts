import { app } from './app.js';
import { env } from './config/env.js';
import { logger } from './core/logger/index.js';

const server = app.listen(env.PORT, env.HOST, () => {
  logger.info({ host: env.HOST, port: env.PORT, environment: env.NODE_ENV }, 'Server started');
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
  server.close((err) => {
    clearTimeout(timer);
    if (err) { logger.error({ err }, 'Shutdown failed'); process.exitCode = 1; }
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
