import type { Clock } from '@herobids/engine';

/**
 * Simulated clock for backtesting — time advances only when explicitly set.
 */
export class SimulatedClock implements Clock {
  private current: string;

  constructor(startIso: string) {
    this.current = startIso;
  }

  now(): string {
    return this.current;
  }

  advance(isoTimestamp: string): void {
    this.current = isoTimestamp;
  }
}
