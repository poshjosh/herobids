import { describe, it, expect } from 'vitest';
import {
  AgentMarketWakePayloadSchema,
  ReminderWakeContextSchema,
  WatchThresholdWakeContextSchema,
  DiscoveryDeltaWakeContextSchema,
  RegimeChangeWakeContextSchema,
} from './agent-protocol.js';

// Shared base fields for all wake payloads
const BASE = {
  wakeId: 'w-1',
  reason: 'test reason',
  eventIds: ['e-1'],
  priority: 'normal' as const,
  requestedAt: '2024-01-01T00:00:00.000Z',
};

describe('AgentMarketWakePayloadSchema', () => {
  describe('reminder wake', () => {
    it('accepts a valid reminder wake payload', () => {
      const result = AgentMarketWakePayloadSchema.safeParse({
        ...BASE,
        source: 'reminder',
        context: { reminderId: 'r-1', message: 'Check price', scheduledBy: 'scout' },
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.source).toBe('reminder');
      if (result.data.source === 'reminder') {
        expect(result.data.context.reminderId).toBe('r-1');
        expect(result.data.context.message).toBe('Check price');
        expect(result.data.context.scheduledBy).toBe('scout');
      }
    });

    it('rejects reminder payload with cross-family context fields', () => {
      const result = AgentMarketWakePayloadSchema.safeParse({
        ...BASE,
        source: 'reminder',
        context: { symbol: 'BTC', network: 'eth' }, // watch_threshold fields
      });
      expect(result.success).toBe(false);
    });

    it('rejects reminder payload without required context', () => {
      const result = AgentMarketWakePayloadSchema.safeParse({ ...BASE, source: 'reminder' });
      expect(result.success).toBe(false);
    });
  });

  describe('watch_threshold wake', () => {
    it('accepts a valid watch_threshold wake payload', () => {
      const result = AgentMarketWakePayloadSchema.safeParse({
        ...BASE,
        source: 'watch_threshold',
        context: {
          watchId: 'wt-1',
          symbol: 'BTC',
          chain: 'ethereum',
          condition: 'above',
          thresholdPrice: 50000,
          currentPrice: 51000,
          stale: false,
          triggeredAt: '2024-01-01T00:00:00.000Z',
        },
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      if (result.data.source === 'watch_threshold') {
        expect(result.data.context.symbol).toBe('BTC');
        expect(result.data.context.condition).toBe('above');
      }
    });

    it('accepts optional note field in watch_threshold context', () => {
      const result = AgentMarketWakePayloadSchema.safeParse({
        ...BASE,
        source: 'watch_threshold',
        context: {
          watchId: 'wt-2',
          symbol: 'ETH',
          chain: 'ethereum',
          condition: 'below',
          thresholdPrice: 2000,
          currentPrice: 1990,
          stale: true,
          triggeredAt: '2024-01-01T00:00:00.000Z',
          note: 'circuit-breaker level',
        },
      });
      expect(result.success).toBe(true);
    });

    it('rejects watch_threshold payload with missing required fields', () => {
      const result = AgentMarketWakePayloadSchema.safeParse({
        ...BASE,
        source: 'watch_threshold',
        context: { symbol: 'BTC' }, // missing watchId, chain, condition, etc.
      });
      expect(result.success).toBe(false);
    });
  });

  describe('discovery_delta wake', () => {
    it('accepts a valid discovery_delta wake payload', () => {
      const result = AgentMarketWakePayloadSchema.safeParse({
        ...BASE,
        source: 'discovery_delta',
        context: {
          symbol: 'PEPE',
          network: 'solana',
          address: '0xabc123',
          reason: 'entered_top_set',
          detectedAt: '2024-01-01T00:00:00.000Z',
        },
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      if (result.data.source === 'discovery_delta') {
        expect(result.data.context.symbol).toBe('PEPE');
        expect(result.data.context.reason).toBe('entered_top_set');
      }
    });

    it('accepts optional rank and liquidity fields', () => {
      const result = AgentMarketWakePayloadSchema.safeParse({
        ...BASE,
        source: 'discovery_delta',
        context: {
          symbol: 'DOGE',
          network: 'ethereum',
          address: '0xdef456',
          reason: 'multi_vector_confirmation',
          rank: 5,
          liquidityUsd: 1_000_000,
          volume24hUsd: 500_000,
          detectedAt: '2024-01-01T00:00:00.000Z',
        },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('regime_change wake', () => {
    it('accepts a valid regime_change wake payload', () => {
      const result = AgentMarketWakePayloadSchema.safeParse({
        ...BASE,
        source: 'regime_change',
        context: {
          benchmarkSymbol: 'BTC',
          previousState: 'bull',
          currentState: 'bear',
          changedAt: '2024-01-01T00:00:00.000Z',
        },
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      if (result.data.source === 'regime_change') {
        expect(result.data.context.benchmarkSymbol).toBe('BTC');
        expect(result.data.context.currentState).toBe('bear');
      }
    });
  });

  it('rejects payload with unknown source', () => {
    const result = AgentMarketWakePayloadSchema.safeParse({
      ...BASE,
      source: 'unknown_source',
      context: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects payload missing source', () => {
    const result = AgentMarketWakePayloadSchema.safeParse({ ...BASE });
    expect(result.success).toBe(false);
  });
});

describe('Source-specific context schemas', () => {
  it('ReminderWakeContextSchema rejects unknown scheduledBy values', () => {
    const result = ReminderWakeContextSchema.safeParse({
      reminderId: 'r-1',
      message: 'hello',
      scheduledBy: 'user', // not scout | judge
    });
    expect(result.success).toBe(false);
  });

  it('WatchThresholdWakeContextSchema rejects unknown condition', () => {
    const result = WatchThresholdWakeContextSchema.safeParse({
      watchId: 'w-1',
      symbol: 'BTC',
      chain: 'ethereum',
      condition: 'sideways', // not above | below
      thresholdPrice: 50000,
      currentPrice: 50001,
      stale: false,
      triggeredAt: '2024-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('DiscoveryDeltaWakeContextSchema rejects non-integer rank', () => {
    const result = DiscoveryDeltaWakeContextSchema.safeParse({
      symbol: 'TOKEN',
      network: 'eth',
      address: '0x123',
      reason: 'new',
      rank: 1.5, // not integer
      detectedAt: '2024-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('RegimeChangeWakeContextSchema requires all non-optional fields', () => {
    const result = RegimeChangeWakeContextSchema.safeParse({
      benchmarkSymbol: 'BTC',
      // missing previousState, currentState, changedAt
    });
    expect(result.success).toBe(false);
  });
});
