import "server-only";
import { createHash } from "node:crypto";

/**
 * DEV-GRADE fixed-window rate limiter held in this process's memory. It is per instance,
 * resets on restart and is bypassable across serverless instances. Production needs a
 * shared store (e.g. Redis/Upstash or a Postgres table) and edge/WAF limits.
 * Keys are SHA-256 hashed so raw IP addresses are never retained.
 */
export class FixedWindowRateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** Records a hit; returns whether it is allowed and when the window resets. */
  hit(rawKey: string, now: number = Date.now()): { allowed: boolean; retryAfterMs: number } {
    const key = createHash("sha256").update(rawKey).digest("hex");
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      if (this.hits.size >= this.maxKeys) this.prune(now);
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    return { allowed: entry.count <= this.max, retryAfterMs: Math.max(0, entry.resetAt - now) };
  }

  /** Whether `rawKey` is currently over the limit, WITHOUT recording a hit. */
  isBlocked(rawKey: string, now: number = Date.now()): boolean {
    const entry = this.hits.get(createHash("sha256").update(rawKey).digest("hex"));
    return !!entry && entry.resetAt > now && entry.count >= this.max;
  }

  reset(): void {
    this.hits.clear();
  }

  private prune(now: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    if (this.hits.size >= this.maxKeys) this.hits.clear(); // fail open under key flooding
  }
}
