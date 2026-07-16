import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildTechnicalContextBlock,
  createRuntimeCompositionState,
  buildTickUserContext,
  applyRuntimeMessage,
  recordTechnicalScan,
  type TechnicalScanState,
} from './runtime-composition.js';

const baseDescriptor = {
  schemaVersion: 'v1' as const,
  agentId: 'agent-1',
  name: 'test-agent',
  goal: 'Trade carefully',
  executionMode: 'paper',
  resolvedSkills: [
    {
      id: 'bot-management',
      name: 'Bot Management',
      description: 'Trading bots',
      instructions: 'Manage trading bots.',
      requiredTools: ['list_bots'],
      capabilityFamilies: ['trading'],
      bindingRequirements: {},
      contextRequirements: [],
      requiredContextBlocks: [],
      promptRendererHints: [],
      requiredGuardrails: [],
      suggestedTickIntervalMs: 900_000,
      visibility: 'public' as const,
    },
  ],
  toolPolicy: {},
  guardrails: {
    dailyTokenBudget: null,
    dailyLossLimit: null,
    maxBots: null,
  },
  readinessByFamily: {
    trading: {
      state: 'ready' as const,
      agentEligibility: 'eligible' as const,
      reasons: [],
      connectionId: 'b1',
      effectiveReady: true,
    },
  },
  grantedConnectionsByFamily: {
    trading: [
      {
        connectionId: 'b1',
        provider: 'hyperliquid',
        isDefault: true,
        readiness: {
          state: 'ready' as const,
          agentEligibility: 'eligible' as const,
          reasons: [],
          connectionId: 'b1',
          effectiveReady: true,
        },
      },
    ],
  },
  defaultConnectionByFamily: {},
  budgets: {
    maxHistoryMessages: 20,
    maxRecentToolMessages: 5,
    maxToolResultChars: 4096,
    maxVisibleToolSchemas: 10,
    maxContextBlockChars: 2000,
  },
};

afterEach(() => {
  vi.useRealTimers();
});

function makeScan(overrides?: Partial<TechnicalScanState>): TechnicalScanState {
  return {
    timestamp: new Date().toISOString(),
    scanIntervalMs: 60_000,
    regimeResult: {
      pass: true,
      reasons: ['ADX strong', 'bullish alignment'],
      details: {
        benchmarkSymbol: 'BTC',
        currentPrice: 65_000,
        adxValue: 32,
        emaAlignment: 'bullish',
        marketStructure: 'higherHighs',
        priceAboveVwap: true,
        choppy: false,
      },
    },
    signals: [
      {
        symbol: 'ETH-PERP',
        instrumentId: 'ETH-PERP',
        confidence: 0.72,
        reasons: ['RSI healthy', 'MACD crossover', 'volume strong'],
        intent: 'go_long',
        indicators: { rsi: 55, macdHistogram: 0.5, volumeRatio: 2.1 },
      },
      {
        symbol: 'SOL-PERP',
        instrumentId: 'SOL-PERP',
        confidence: 0.58,
        reasons: ['RSI healthy', 'MACD positive'],
        intent: 'go_long',
        indicators: { rsi: 48, macdHistogram: 0.2, volumeRatio: 1.6, choch: 'bullish' },
      },
    ],
    positionIndicators: [
      {
        symbol: 'ARB-PERP',
        side: 'long',
        entryPrice: 1.2,
        rsi: 71,
        signalNote: 'Weakening (approaching overbought)',
      },
    ],
    summary: { scanned: 15, rejected: 12, passed: 3 },
    symbolOutcomes: [
      { symbol: 'ETH-PERP', status: 'eligible_fetched', candleCount: 100 },
      { symbol: 'SOL-PERP', status: 'eligible_fetched', candleCount: 100 },
      { symbol: 'ARB-PERP', status: 'eligible_fetched', candleCount: 100 },
    ],
    discovered: 15,
    symbolsSelected: 3,
    eligible: 3,
    fetched: 3,
    unsupported: 0,
    fetchFailures: 0,
    signalsGenerated: 2,
    ...overrides,
  };
}

describe('buildTechnicalContextBlock', () => {
  it('renders a markdown block from sample scan results', () => {
    const block = buildTechnicalContextBlock(makeScan());

    expect(block).not.toBeNull();
    expect(block).toContain('## Technical Scan Results');
    expect(block).toContain('ETH-PERP');
    expect(block).toContain('0.72');
    expect(block).toContain('RSI healthy');
    expect(block).toContain('Regime: PASS');
    expect(block).toContain('15 instruments scanned');
    expect(block).toContain('12 rejected');
  });

  it('returns null for stale scan data (timestamp > 2x scanIntervalMs ago)', () => {
    vi.useFakeTimers();
    const scan = makeScan({ scanIntervalMs: 60_000 });
    // Advance time by 3 scan intervals (> 2x stale threshold)
    vi.advanceTimersByTime(3 * 60_000);

    const block = buildTechnicalContextBlock(scan);
    expect(block).toBeNull();
  });

  it('fresh scan (within 2x scanIntervalMs) is included', () => {
    vi.useFakeTimers();
    const scan = makeScan({ scanIntervalMs: 60_000 });
    vi.advanceTimersByTime(60_000); // 1x interval — still fresh (< 2x)

    const block = buildTechnicalContextBlock(scan);
    expect(block).not.toBeNull();
  });

  it('truncates signals to maxSignalsInContext by confidence', () => {
    const manySignals = Array.from({ length: 15 }, (_, i) => ({
      symbol: `TOKEN${i}-PERP`,
      instrumentId: `TOKEN${i}-PERP`,
      confidence: (15 - i) / 15,
      reasons: [`reason ${i}`],
      intent: 'go_long' as const,
      indicators: {},
    }));

    const scan = makeScan({ signals: manySignals, summary: { scanned: 20, rejected: 5, passed: 15 } });
    const block = buildTechnicalContextBlock(scan, { maxSignalsInContext: 5 });

    expect(block).not.toBeNull();
    // Only first 5 signals (highest confidence) should appear
    expect(block).toContain('TOKEN0-PERP');
    expect(block).toContain('TOKEN4-PERP');
    expect(block).not.toContain('TOKEN5-PERP');
  });

  it('returns null when no signals and no regime and no position indicators', () => {
    const scan = makeScan({
      signals: [],
      regimeResult: null,
      positionIndicators: [],
    });
    const block = buildTechnicalContextBlock(scan);
    expect(block).toBeNull();
  });

  it('includes open position indicators when present', () => {
    const block = buildTechnicalContextBlock(makeScan());
    expect(block).toContain('### Open Positions');
    expect(block).toContain('ARB-PERP');
    expect(block).toContain('Weakening');
  });

  it('renders blocked regime correctly', () => {
    const scan = makeScan({
      regimeResult: {
        pass: false,
        reasons: ['ADX too low', 'bearish structure'],
        details: {
          benchmarkSymbol: 'BTC',
          currentPrice: 60_000,
          adxValue: 18,
          emaAlignment: 'bearish',
          marketStructure: 'lowerHighs',
          priceAboveVwap: false,
          choppy: true,
        },
      },
    });
    const block = buildTechnicalContextBlock(scan);
    expect(block).not.toBeNull();
    expect(block).toContain('Regime: BLOCK');
  });

  it('renders —bearish for negative macdHistogram', () => {
    const scan = makeScan({
      signals: [
        {
          symbol: 'ETH-PERP',
          instrumentId: 'ETH-PERP',
          confidence: 0.6,
          reasons: ['bearish signal'],
          intent: 'go_long' as const,
          indicators: { rsi: 45, macdHistogram: -0.5, volumeRatio: 1.2 },
        },
      ],
    });
    const block = buildTechnicalContextBlock(scan);
    expect(block).not.toBeNull();
    expect(block).toContain('\u2014bearish');
  });
});

describe('technical scan in runtimeState context', () => {
  it('technical context block appears when lastTechnicalScan is set and fresh', () => {
    const state = createRuntimeCompositionState(baseDescriptor as Parameters<typeof createRuntimeCompositionState>[0]);
    recordTechnicalScan(state, makeScan());

    const context = buildTickUserContext(state, []);
    expect(context).toContain('Technical Scan Results');
    expect(context).toContain('ETH-PERP');
  });

  it('no technical block when lastTechnicalScan is absent (intelligence-only agent)', () => {
    const state = createRuntimeCompositionState(baseDescriptor as Parameters<typeof createRuntimeCompositionState>[0]);
    // Do not set lastTechnicalScan

    const context = buildTickUserContext(state, []);
    expect(context).not.toContain('Technical Scan Results');
  });

  it('handles agent.technical.scan_completed message and updates state', () => {
    const state = createRuntimeCompositionState(baseDescriptor as Parameters<typeof createRuntimeCompositionState>[0]);
    const scan = makeScan();

    applyRuntimeMessage(state, {
      type: 'agent.technical.scan_completed',
      payload: scan,
    });

    expect(state.metrics.lastTechnicalScan).toBeDefined();
    expect(state.metrics.lastTechnicalScan?.signals).toHaveLength(2);
    expect(state.metrics.lastTechnicalScan?.summary.passed).toBe(3);
  });

  it('does not update lastTechnicalScan when agent.technical.scan_completed payload is invalid', () => {
    const state = createRuntimeCompositionState(baseDescriptor as Parameters<typeof createRuntimeCompositionState>[0]);

    // Missing timestamp — should not update lastTechnicalScan
    applyRuntimeMessage(state, {
      type: 'agent.technical.scan_completed',
      payload: { signals: [], summary: { scanned: 0, rejected: 0, passed: 0 } },
    });
    expect(state.metrics.lastTechnicalScan).toBeUndefined();

    // Missing signals array — should not update lastTechnicalScan
    applyRuntimeMessage(state, {
      type: 'agent.technical.scan_completed',
      payload: { timestamp: new Date().toISOString(), summary: { scanned: 0, rejected: 0, passed: 0 } },
    });
    expect(state.metrics.lastTechnicalScan).toBeUndefined();

    // Missing summary — should not update lastTechnicalScan
    applyRuntimeMessage(state, {
      type: 'agent.technical.scan_completed',
      payload: { timestamp: new Date().toISOString(), signals: [] },
    });
    expect(state.metrics.lastTechnicalScan).toBeUndefined();
  });
});

// ── recordTechnicalScan → runtime state handoff ──────────────────────────────

describe('recordTechnicalScan → runtime state handoff', () => {
  it('recordTechnicalScan sets lastTechnicalScan with complete health matrix fields', () => {
    const state = createRuntimeCompositionState(baseDescriptor as Parameters<typeof createRuntimeCompositionState>[0]);
    const scan = makeScan({
      discovered: 30,
      symbolsSelected: 12,
      eligible: 10,
      fetched: 8,
      unsupported: 2,
      fetchFailures: 1,
      signalsGenerated: 3,
    });

    recordTechnicalScan(state, scan);

    expect(state.metrics.lastTechnicalScan).toBeDefined();
    const stored = state.metrics.lastTechnicalScan!;
    expect(stored.discovered).toBe(30);
    expect(stored.symbolsSelected).toBe(12);
    expect(stored.eligible).toBe(10);
    expect(stored.fetched).toBe(8);
    expect(stored.unsupported).toBe(2);
    expect(stored.fetchFailures).toBe(1);
    expect(stored.signalsGenerated).toBe(3);
  });

  it('recordTechnicalScan replaces a prior scan on update', () => {
    const state = createRuntimeCompositionState(baseDescriptor as Parameters<typeof createRuntimeCompositionState>[0]);

    const scan1 = makeScan({ signalsGenerated: 1, timestamp: new Date('2026-07-01T10:00:00Z').toISOString() });
    recordTechnicalScan(state, scan1);
    expect(state.metrics.lastTechnicalScan?.signalsGenerated).toBe(1);

    const scan2 = makeScan({ signalsGenerated: 5, timestamp: new Date('2026-07-01T10:01:00Z').toISOString() });
    recordTechnicalScan(state, scan2);
    expect(state.metrics.lastTechnicalScan?.signalsGenerated).toBe(5);
  });
});
