import type { ClockPort, RateLimiterPort } from '../domain/ports.js';

/** Above this many live keys, expired buckets are swept before adding more. */
const SWEEP_THRESHOLD = 10_000;

// ponytail: in-memory, single-instance only. A second backend instance would
// have its own counters. Swap for Redis if this ever runs horizontally --
// the port makes it a composition-root change.
export class InMemoryRateLimiter implements RateLimiterPort {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly clock: ClockPort) {}

  async consume(key: string, limit: number, windowMs: number): Promise<boolean> {
    const now = this.clock.now().getTime();
    const bucket = this.buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      // Keys include client IPs, which an attacker picks -- without this the
      // map is an unbounded, remotely-grown allocation.
      if (this.buckets.size >= SWEEP_THRESHOLD) this.sweep(now);
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }

    if (bucket.count >= limit) return false;
    bucket.count += 1;
    return true;
  }

  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}
