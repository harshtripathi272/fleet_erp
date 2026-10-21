import { createClient } from 'redis';
import { env } from '../../config/env.js';
import { logger } from '../logger/index.js';

const makeClient = (url: string) => createClient({ url, socket: { reconnectStrategy: (retries: number) => Math.min(retries * 200, 5000) } });
export type RedisClient = ReturnType<typeof makeClient>;
let client: RedisClient | null = null;

/** Redis is optional: without REDIS_URL the API uses in-process fallbacks. */
export async function connectRedis(url: string | undefined = env.REDIS_URL): Promise<RedisClient | null> {
  if (!url) {
    logger.warn({}, 'REDIS_URL not set; rate limits are kept in process memory');
    return null;
  }
  const next = makeClient(url);
  next.on('error', (err) => logger.error({ err }, 'Redis error'));
  await next.connect();
  client = next;
  logger.info({}, 'Redis connected');
  return client;
}

export function getRedis(): RedisClient | null {
  return client?.isReady ? client : null;
}

export async function disconnectRedis(): Promise<void> {
  if (client) await client.quit().catch(() => undefined);
  client = null;
}
