export interface RateLimiterConfig {
  requestsPerMinute: number;
  burstCapacity?: number;
  maxWaitMs?: number;
}

/**
 * Simple token-bucket rate limiter.
 * Per-process (in-memory). If multiple worker instances run in parallel,
 * shared rate limiting would need Redis — out of scope.
 */
export class TokenBucketRateLimiter {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillRate: number; // tokens per ms
  private lastRefill: number;
  private readonly maxWaitMs: number;

  constructor(config: RateLimiterConfig) {
    this.capacity = config.burstCapacity ?? config.requestsPerMinute;
    this.tokens = this.capacity;
    this.refillRate = config.requestsPerMinute / 60_000;
    this.lastRefill = Date.now();
    this.maxWaitMs = config.maxWaitMs ?? 30_000;
  }

  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    const waitMs = (1 - this.tokens) / this.refillRate;
    if (waitMs > this.maxWaitMs) {
      throw new Error(`Rate limit exceeded — would need to wait ${Math.ceil(waitMs)}ms (max: ${this.maxWaitMs}ms)`);
    }

    await this.sleep(Math.ceil(waitMs));
    this.refill();
    this.tokens -= 1;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
