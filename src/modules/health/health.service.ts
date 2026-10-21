import { getRedis } from '../../core/cache/redis.js';
import { mongoState } from '../../core/db/mongo.js';
import { env } from '../../config/env.js';

export async function getHealth() {
  return { status: 'ok', service: 'fleet-erp', timestamp: new Date().toISOString() };
}

/** Readiness: MongoDB must be connected; Redis is reported but optional. */
export async function getReadiness() {
  const mongo = mongoState();
  const redis = env.REDIS_URL ? (getRedis() ? 'connected' : 'disconnected') : 'not-configured';
  return { ready: mongo === 'connected', mongo, redis, timestamp: new Date().toISOString() };
}
