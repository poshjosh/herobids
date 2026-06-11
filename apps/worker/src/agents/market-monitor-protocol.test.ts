import { describe, it, expect } from 'vitest';
import {
  MarketWatchTriggeredPayloadSchema,
  MarketDiscoveryDetectedPayloadSchema,
  MarketRegimeChangedPayloadSchema,
  AgentMarketWakePayloadSchema,
  MARKET_MONITOR_MESSAGE_TYPES,
  MESSAGE_PAYLOAD_SCHEMAS,
  validateMessage,
} from '@herobids/domain';

// ---------------------------------------------------------------------------
// MarketWatchTriggeredPayloadSchema
// ---------------------------------------------------------------------------

describe('MarketWatchTriggeredPayloadSchema', () => {
  const valid = {
    eventId: 'evt-001',
    monitorType: 'watch_threshold' as const,
    watchId: 'watch-1',
    symbol: 'SOL',
    chain: 'solana',
    condition: 'above' as const,
    thresholdPrice: 200,
    currentPrice: 204.12,
    priceSource: 'discovery_snapshot',
    stale: false,
    triggeredAt: '2026-06-10T12:34:56.000Z',
  };

  it('accepts a complete valid payload', () => {
    expect(MarketWatchTriggeredPayloadSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts both "above" and "below" conditions', () => {
    expect(MarketWatchTriggeredPayloadSchema.safeParse({ ...valid, condition: 'above' }).success).toBe(true);
    expect(MarketWatchTriggeredPayloadSchema.safeParse({ ...valid, condition: 'below' }).success).toBe(true);
  });

  it('accepts optional note field', () => {
    expect(MarketWatchTriggeredPayloadSchema.safeParse({ ...valid, note: 'breakout watch' }).success).toBe(true);
  });

  it('rejects invalid condition value', () => {
    expect(MarketWatchTriggeredPayloadSchema.safeParse({ ...valid, condition: 'sideways' }).success).toBe(false);
  });

  it('rejects wrong monitorType', () => {
    expect(MarketWatchTriggeredPayloadSchema.safeParse({ ...valid, monitorType: 'wrong' }).success).toBe(false);
  });

  it('rejects non-ISO triggeredAt', () => {
    expect(MarketWatchTriggeredPayloadSchema.safeParse({ ...valid, triggeredAt: 'not-a-date' }).success).toBe(false);
  });

  it('rejects missing eventId', () => {
    const { eventId: _, ...rest } = valid;
    expect(MarketWatchTriggeredPayloadSchema.safeParse(rest).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MarketDiscoveryDetectedPayloadSchema
// ---------------------------------------------------------------------------

describe('MarketDiscoveryDetectedPayloadSchema', () => {
  const valid = {
    eventId: 'evt-002',
    monitorType: 'discovery_delta' as const,
    symbol: 'WIF',
    network: 'solana',
    address: '0xabc123',
    reason: 'entered_top_set' as const,
    detectedAt: '2026-06-10T12:35:10.000Z',
  };

  it('accepts a minimal valid payload', () => {
    expect(MarketDiscoveryDetectedPayloadSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts all three reason values', () => {
    for (const reason of ['entered_top_set', 'reappeared_after_cooldown', 'multi_vector_confirmation']) {
      const result = MarketDiscoveryDetectedPayloadSchema.safeParse({ ...valid, reason });
      expect(result.success, `reason=${reason}`).toBe(true);
    }
  });

  it('rejects unknown reason', () => {
    expect(MarketDiscoveryDetectedPayloadSchema.safeParse({ ...valid, reason: 'new_coin' }).success).toBe(false);
  });

  it('accepts optional rank, liquidityUsd, volume24hUsd, discoveryVectors', () => {
    const full = {
      ...valid,
      rank: 3,
      liquidityUsd: 1_450_000,
      volume24hUsd: 8_300_000,
      discoveryVectors: ['trending', 'boosts_latest'],
    };
    expect(MarketDiscoveryDetectedPayloadSchema.safeParse(full).success).toBe(true);
  });

  it('rejects wrong monitorType', () => {
    expect(MarketDiscoveryDetectedPayloadSchema.safeParse({ ...valid, monitorType: 'watch_threshold' }).success).toBe(false);
  });

  it('rejects non-ISO detectedAt', () => {
    expect(MarketDiscoveryDetectedPayloadSchema.safeParse({ ...valid, detectedAt: 'yesterday' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MarketRegimeChangedPayloadSchema
// ---------------------------------------------------------------------------

describe('MarketRegimeChangedPayloadSchema', () => {
  const valid = {
    eventId: 'evt-003',
    monitorType: 'regime_change' as const,
    benchmarkSymbol: 'BTC',
    previousState: 'favorable',
    currentState: 'unfavorable',
    changedAt: '2026-06-10T12:36:00.000Z',
  };

  it('accepts a valid payload', () => {
    expect(MarketRegimeChangedPayloadSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts optional details', () => {
    const result = MarketRegimeChangedPayloadSchema.safeParse({
      ...valid,
      details: { emaAlignment: 'bearish', adxValue: 18.4, choppy: true },
    });
    expect(result.success).toBe(true);
  });

  it('rejects wrong monitorType', () => {
    expect(MarketRegimeChangedPayloadSchema.safeParse({ ...valid, monitorType: 'discovery_delta' }).success).toBe(false);
  });

  it('rejects missing benchmarkSymbol', () => {
    const { benchmarkSymbol: _, ...rest } = valid;
    expect(MarketRegimeChangedPayloadSchema.safeParse(rest).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AgentMarketWakePayloadSchema
// ---------------------------------------------------------------------------

describe('AgentMarketWakePayloadSchema', () => {
  const valid = {
    wakeId: 'wake-001',
    reason: 'SOL crossed above 200',
    eventIds: ['evt-1', 'evt-2'],
    priority: 'normal' as const,
    requestedAt: '2026-06-10T12:36:02.000Z',
  };

  it('accepts a valid payload', () => {
    expect(AgentMarketWakePayloadSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts all priority values', () => {
    for (const priority of ['low', 'normal', 'high']) {
      expect(AgentMarketWakePayloadSchema.safeParse({ ...valid, priority }).success, `priority=${priority}`).toBe(true);
    }
  });

  it('rejects invalid priority', () => {
    expect(AgentMarketWakePayloadSchema.safeParse({ ...valid, priority: 'critical' }).success).toBe(false);
  });

  it('accepts optional notBefore', () => {
    expect(AgentMarketWakePayloadSchema.safeParse({ ...valid, notBefore: '2026-06-10T12:36:05.000Z' }).success).toBe(true);
  });

  it('rejects non-ISO notBefore', () => {
    expect(AgentMarketWakePayloadSchema.safeParse({ ...valid, notBefore: 'in 5 seconds' }).success).toBe(false);
  });

  it('accepts empty eventIds array', () => {
    expect(AgentMarketWakePayloadSchema.safeParse({ ...valid, eventIds: [] }).success).toBe(true);
  });

  it('accepts typed source and context fields', () => {
    const typed = {
      ...valid,
      source: 'watch_threshold' as const,
      context: { symbol: 'SOL', chain: 'solana', thresholdPrice: 200, currentPrice: 204 },
    };
    expect(AgentMarketWakePayloadSchema.safeParse(typed).success).toBe(true);
  });

  it('accepts all valid source values', () => {
    for (const source of ['reminder', 'watch_threshold', 'discovery_delta', 'regime_change']) {
      expect(AgentMarketWakePayloadSchema.safeParse({ ...valid, source }).success, `source=${source}`).toBe(true);
    }
  });

  it('rejects invalid source value', () => {
    expect(AgentMarketWakePayloadSchema.safeParse({ ...valid, source: 'unknown_source' }).success).toBe(false);
  });

  it('accepts payload without source/context for backward compatibility', () => {
    const legacyPayload = {
      wakeId: 'wake-legacy',
      reason: 'market_monitor_triggered',
      eventIds: ['evt-1'],
      priority: 'normal' as const,
      requestedAt: '2026-06-10T12:36:02.000Z',
    };
    expect(AgentMarketWakePayloadSchema.safeParse(legacyPayload).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MARKET_MONITOR_MESSAGE_TYPES constants
// ---------------------------------------------------------------------------

describe('MARKET_MONITOR_MESSAGE_TYPES', () => {
  it('defines the four expected message type strings', () => {
    expect(MARKET_MONITOR_MESSAGE_TYPES.WATCH_TRIGGERED).toBe('market.watch.triggered');
    expect(MARKET_MONITOR_MESSAGE_TYPES.DISCOVERY_DETECTED).toBe('market.discovery.detected');
    expect(MARKET_MONITOR_MESSAGE_TYPES.REGIME_CHANGED).toBe('market.regime.changed');
    expect(MARKET_MONITOR_MESSAGE_TYPES.AGENT_WAKE).toBe('agent.market.wake');
  });

  it('all four types are registered in MESSAGE_PAYLOAD_SCHEMAS', () => {
    expect(MESSAGE_PAYLOAD_SCHEMAS[MARKET_MONITOR_MESSAGE_TYPES.WATCH_TRIGGERED]).toBeDefined();
    expect(MESSAGE_PAYLOAD_SCHEMAS[MARKET_MONITOR_MESSAGE_TYPES.DISCOVERY_DETECTED]).toBeDefined();
    expect(MESSAGE_PAYLOAD_SCHEMAS[MARKET_MONITOR_MESSAGE_TYPES.REGIME_CHANGED]).toBeDefined();
    expect(MESSAGE_PAYLOAD_SCHEMAS[MARKET_MONITOR_MESSAGE_TYPES.AGENT_WAKE]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// validateMessage round-trip for market monitor types
// ---------------------------------------------------------------------------

describe('validateMessage — market monitor envelope round-trips', () => {
  const baseEnvelope = {
    messageId: 'msg-1',
    correlationId: 'corr-1',
    initiatorType: 'system',
    initiatorId: 'worker-123',
    agentId: 'agent-abc',
    createdAt: '2026-06-10T12:00:00.000Z',
  };

  it('accepts a valid market.watch.triggered envelope', () => {
    const result = validateMessage({
      ...baseEnvelope,
      type: 'market.watch.triggered',
      payload: {
        eventId: 'e1',
        monitorType: 'watch_threshold',
        watchId: 'w1',
        symbol: 'SOL',
        chain: 'solana',
        condition: 'above',
        thresholdPrice: 200,
        currentPrice: 205,
        priceSource: 'snapshot',
        stale: false,
        triggeredAt: '2026-06-10T12:00:00.000Z',
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid market.discovery.detected envelope', () => {
    const result = validateMessage({
      ...baseEnvelope,
      type: 'market.discovery.detected',
      payload: {
        eventId: 'e2',
        monitorType: 'discovery_delta',
        symbol: 'WIF',
        network: 'solana',
        address: '0xabc',
        reason: 'entered_top_set',
        detectedAt: '2026-06-10T12:00:00.000Z',
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid market.regime.changed envelope', () => {
    const result = validateMessage({
      ...baseEnvelope,
      type: 'market.regime.changed',
      payload: {
        eventId: 'e3',
        monitorType: 'regime_change',
        benchmarkSymbol: 'BTC',
        previousState: 'favorable',
        currentState: 'unfavorable',
        changedAt: '2026-06-10T12:00:00.000Z',
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid agent.market.wake envelope', () => {
    const result = validateMessage({
      ...baseEnvelope,
      type: 'agent.market.wake',
      payload: {
        wakeId: 'wake-1',
        reason: 'SOL crossed above 200',
        eventIds: ['e1', 'e2'],
        priority: 'normal',
        requestedAt: '2026-06-10T12:00:00.000Z',
        source: 'watch_threshold',
        context: { symbol: 'SOL', chain: 'solana', thresholdPrice: 200, currentPrice: 204 },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a legacy agent.market.wake envelope without source/context', () => {
    const result = validateMessage({
      ...baseEnvelope,
      type: 'agent.market.wake',
      payload: {
        wakeId: 'wake-1',
        reason: 'market_monitor_triggered',
        eventIds: ['e1', 'e2'],
        priority: 'normal',
        requestedAt: '2026-06-10T12:00:00.000Z',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects market.watch.triggered envelope with invalid payload', () => {
    const result = validateMessage({
      ...baseEnvelope,
      type: 'market.watch.triggered',
      payload: {
        // missing required fields
        symbol: 'SOL',
      },
    });
    expect(result.success).toBe(false);
  });
});
