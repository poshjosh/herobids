/**
 * Venue error circuit breaker.
 * Trips after N consecutive venue errors, halting execution until manually reset
 * or until a success resets the counter.
 */
export class VenueCircuitBreaker {
  private consecutiveErrors = 0;
  private tripped = false;

  constructor(private readonly maxConsecutiveErrors: number) {}

  /** Record a successful execution — resets counter and closes breaker */
  recordSuccess(): void {
    this.consecutiveErrors = 0;
    this.tripped = false;
  }

  /** Record a venue error — increments counter, returns true if breaker tripped */
  recordError(): boolean {
    this.consecutiveErrors++;
    if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
      this.tripped = true;
    }
    return this.tripped;
  }

  /** Whether the breaker is currently open (tripped) */
  get isOpen(): boolean {
    return this.tripped;
  }

  /** Manual reset */
  reset(): void {
    this.consecutiveErrors = 0;
    this.tripped = false;
  }

  /** Current consecutive error count */
  get errorCount(): number {
    return this.consecutiveErrors;
  }
}
