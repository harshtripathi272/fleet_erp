import type { RedisClient } from '../cache/redis.js';

export interface HitResult { allowed: boolean; count: number; remaining: number; resetMs: number; }
export interface RateLimitStore { hit(key: string, limit: number, windowMs: number): Promise<HitResult>; reset(key: string): Promise<void>; }

/** Fixed-window counter held in process memory (single instance or no Redis). */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = Date.now();

  /** `maxKeys` bounds memory when many addresses or accounts are tried at once; the oldest windows go first. */
  constructor(private readonly maxKeys = 100000) {}

  get size() { return this.windows.size; }

  async hit(key: string, limit: number, windowMs: number): Promise<HitResult> {
    const now = Date.now();
    if (now - this.lastSweep > 60000) this.sweep(now);
    if (this.windows.size >= this.maxKeys && !this.windows.has(key)) {
      this.sweep(now);
      for (const oldest of this.windows.keys()) {
        if (this.windows.size < this.maxKeys) break;
        this.windows.delete(oldest);
      }
    }
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, window);
    }
    window.count += 1;
    return { allowed: window.count <= limit, count: window.count, remaining: Math.max(0, limit - window.count), resetMs: window.resetAt - now };
  }

  async reset(key: string): Promise<void> { this.windows.delete(key); }

  private sweep(now: number) {
    this.lastSweep = now;
    for (const [key, window] of this.windows) if (window.resetAt <= now) this.windows.delete(key);
  }
}

type RedisLike = Pick<RedisClient, 'multi' | 'del'>;

/** Fixed-window counter shared through Redis across API instances. */
export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: RedisLike, private readonly prefix = 'rl:') {}

  async hit(key: string, limit: number, windowMs: number): Promise<HitResult> {
    const redisKey = this.prefix + key;
    const [, countReply, ttlReply] = await this.redis.multi()
      .set(redisKey, '0', { PX: windowMs, NX: true })
      .incr(redisKey)
      .pTTL(redisKey)
      .exec() as unknown as [unknown, number, number];
    const count = Number(countReply);
    const ttl = Number(ttlReply);
    return { allowed: count <= limit, count, remaining: Math.max(0, limit - count), resetMs: ttl > 0 ? ttl : windowMs };
  }

  async reset(key: string): Promise<void> { await this.redis.del(this.prefix + key); }
}
