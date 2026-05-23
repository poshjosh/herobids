/**
 * Token-bucket rate limiter — in-memory, per-adapter instance.
 * Supports bursting up to capacity and refills at a steady rate.
 * Serializes waiters via a FIFO queue to prevent oversubscription.
 */
export interface RateLimiterConfig {
  /** Maximum tokens (burst capacity) */
  capacity: number;
  /** Tokens added per second */
  refillRate: number;
}

interface Waiter {
  resolve: (waited: number) => void;
  enqueuedAt: number;
}

export class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillRate: number;
  private readonly queue: Waiter[] = [];
  private draining = false;

  constructor(config: RateLimiterConfig) {
    this.capacity = config.capacity;
    this.refillRate = config.refillRate;
    this.tokens = config.capacity;
    this.lastRefill = Date.now();
  }

  /** Attempt to consume one token. Returns true if permitted, false if rate-limited. */
  tryConsume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Wait until a token is available, then consume it.
   * Waiters are served FIFO — no concurrent oversubscription.
   * Returns the time waited in ms.
   */
  async waitForToken(): Promise<number> {
    this.refill();
    if (this.tokens >= 1 && this.queue.length === 0) {
      this.tokens -= 1;
      return 0;
    }

    return new Promise<number>((resolve) => {
      this.queue.push({ resolve, enqueuedAt: Date.now() });
      this.scheduleDrain();
    });
  }

  /** Current available tokens (for diagnostics) */
  get available(): number {
    this.refill();
    return this.tokens;
  }

  private scheduleDrain(): void {
    if (this.draining) return;
    this.draining = true;
    this.drain();
  }

  private drain(): void {
    this.refill();
    while (this.queue.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      const waiter = this.queue.shift()!;
      waiter.resolve(Date.now() - waiter.enqueuedAt);
    }
    if (this.queue.length > 0) {
      const deficit = 1 - this.tokens;
      const waitMs = Math.ceil((deficit / this.refillRate) * 1000) + 1;
      setTimeout(() => this.drain(), waitMs);
    } else {
      this.draining = false;
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}
