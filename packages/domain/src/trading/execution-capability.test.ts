import { describe, it, expect } from 'vitest';
import { venueTypeFromProvider, validateExecutionCapability } from './execution-capability.js';
import type { ExecutionCapabilityInput } from './execution-capability.js';

describe('venueTypeFromProvider', () => {
  it('returns swap for jupiter', () => {
    expect(venueTypeFromProvider('jupiter')).toBe('swap');
  });

  it('returns swap for 1inch', () => {
    expect(venueTypeFromProvider('1inch')).toBe('swap');
  });

  it('returns orderbook for hyperliquid', () => {
    expect(venueTypeFromProvider('hyperliquid')).toBe('orderbook');
  });

  it('returns orderbook for bybit', () => {
    expect(venueTypeFromProvider('bybit')).toBe('orderbook');
  });

  it('returns undefined for unknown provider', () => {
    expect(venueTypeFromProvider('unknown-venue')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(venueTypeFromProvider('')).toBeUndefined();
  });
});

describe('validateExecutionCapability', () => {
  function input(overrides: Partial<ExecutionCapabilityInput> = {}): ExecutionCapabilityInput {
    return {
      actorType: 'agent',
      executionMode: 'paper',
      venueType: 'orderbook',
      ...overrides,
    };
  }

  describe('execution_mode_required', () => {
    it('fails when executionMode is null', () => {
      const result = validateExecutionCapability(input({ executionMode: null }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('execution_mode_required');
      }
    });

    it('fails when executionMode is undefined', () => {
      const result = validateExecutionCapability(input({ executionMode: undefined }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('execution_mode_required');
      }
    });

    it('fails for bot actor with null executionMode', () => {
      const result = validateExecutionCapability(input({ actorType: 'bot', executionMode: null }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('execution_mode_required');
      }
    });
  });

  describe('paper_swap_not_supported', () => {
    it('fails for paper mode on swap venue', () => {
      const result = validateExecutionCapability(input({ executionMode: 'paper', venueType: 'swap' }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('paper_swap_not_supported');
      }
    });

    it('passes for shadow mode on swap venue', () => {
      const result = validateExecutionCapability(input({ executionMode: 'shadow', venueType: 'swap' }));
      expect(result.ok).toBe(true);
    });

    it('passes for live mode on swap venue', () => {
      const result = validateExecutionCapability(input({ executionMode: 'live', venueType: 'swap' }));
      expect(result.ok).toBe(true);
    });
  });

  describe('valid combinations', () => {
    it('passes for paper mode on orderbook venue', () => {
      const result = validateExecutionCapability(input({ executionMode: 'paper', venueType: 'orderbook' }));
      expect(result.ok).toBe(true);
    });

    it('passes for shadow mode on orderbook venue', () => {
      const result = validateExecutionCapability(input({ executionMode: 'shadow', venueType: 'orderbook' }));
      expect(result.ok).toBe(true);
    });

    it('passes for live mode on orderbook venue', () => {
      const result = validateExecutionCapability(input({ executionMode: 'live', venueType: 'orderbook' }));
      expect(result.ok).toBe(true);
    });

    it('passes for bot actor with valid combination', () => {
      const result = validateExecutionCapability(input({ actorType: 'bot', executionMode: 'live', venueType: 'swap' }));
      expect(result.ok).toBe(true);
    });
  });
});
