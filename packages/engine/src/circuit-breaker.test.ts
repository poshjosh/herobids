import { describe, it, expect } from 'vitest';
import { VenueCircuitBreaker } from './circuit-breaker.js';

describe('VenueCircuitBreaker', () => {
  it('trips after N consecutive errors', () => {
    const cb = new VenueCircuitBreaker(3);
    expect(cb.isOpen).toBe(false);
    cb.recordError();
    expect(cb.isOpen).toBe(false);
    cb.recordError();
    expect(cb.isOpen).toBe(false);
    const tripped = cb.recordError();
    expect(tripped).toBe(true);
    expect(cb.isOpen).toBe(true);
  });

  it('resets on success', () => {
    const cb = new VenueCircuitBreaker(3);
    cb.recordError();
    cb.recordError();
    cb.recordSuccess();
    expect(cb.isOpen).toBe(false);
    expect(cb.errorCount).toBe(0);
    // After reset, need 3 more errors to trip
    cb.recordError();
    cb.recordError();
    expect(cb.isOpen).toBe(false);
  });

  it('does not trip on non-consecutive errors', () => {
    const cb = new VenueCircuitBreaker(3);
    cb.recordError();
    cb.recordError();
    cb.recordSuccess(); // resets counter
    cb.recordError();
    cb.recordError();
    expect(cb.isOpen).toBe(false);
  });

  it('manual reset closes the breaker', () => {
    const cb = new VenueCircuitBreaker(2);
    cb.recordError();
    cb.recordError();
    expect(cb.isOpen).toBe(true);
    cb.reset();
    expect(cb.isOpen).toBe(false);
    expect(cb.errorCount).toBe(0);
  });

  it('stays tripped after trip until reset or success', () => {
    const cb = new VenueCircuitBreaker(1);
    cb.recordError();
    expect(cb.isOpen).toBe(true);
    cb.recordError(); // still tripped
    expect(cb.isOpen).toBe(true);
    cb.recordSuccess();
    expect(cb.isOpen).toBe(false);
  });
});
