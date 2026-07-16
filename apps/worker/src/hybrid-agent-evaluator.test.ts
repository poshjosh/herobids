import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callLlmProvider } from '@herobids/llm';
import { runHybridEvaluator, canRouteToHybridEvaluator } from './hybrid-agent-evaluator.js';
import { createRuntimeCompositionState, type TechnicalScanState } from './runtime-composition.js';
import { buildHybridPrompt } from './hybrid-agent-prompt.js';

vi.mock('@herobids/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@herobids/llm')>();
  return {
    ...actual,
    callLlmProvider: vi.fn(),
  };
});

const mockedCallLlmProvider = vi.mocked(callLlmProvider);

const baseDescriptor = {
  schemaVersion: 'v1' as const,
  agentId: 'agent-1',
  name: 'test-agent',
  goal: 'Trade carefully',
  executionMode: 'paper',
  resolvedSkills: [],
  toolPolicy: {},
  guardrails: {
    dailyTokenBudget: null,
    dailyLossLimit: null,
    maxBots: null,
  },
  readinessByFamily: {},
  grantedConnectionsByFamily: {},
  defaultConnectionByFamily: {},
  budgets: {
    maxHistoryMessages: 20,
    maxHistoryTokens: 40000,
    maxRecentToolMessages: 5,
    maxToolResultChars: 4096,
    maxVisibleToolSchemas: 10,
    maxContextBlockChars: 2000,
  },
};

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeScan(): TechnicalScanState {
  return {
    timestamp: new Date().toISOString(),
    scanIntervalMs: 60_000,
    regimeResult: null,
    signals: [
      {
        symbol: 'BTC',
        instrumentId: 'BTC-PERP',
        confidence: 0.92,
        reasons: ['RSI healthy', 'volume strong'],
        intent: 'go_long',
        indicators: {
          rsi: 58,
          macdHistogram: 1.2,
          volumeRatio: 1.8,
          choch: 'bullish',
        },
      },
    ],
    positionIndicators: [],
    summary: { scanned: 1, rejected: 0, passed: 1 },
    symbolOutcomes: [{ symbol: 'BTC', status: 'eligible_fetched', candleCount: 100 }],
    discovered: 1,
    symbolsSelected: 1,
    eligible: 1,
    fetched: 1,
    unsupported: 0,
    fetchFailures: 0,
    signalsGenerated: 1,
  };
}

function makeState() {
  const state = createRuntimeCompositionState(baseDescriptor);
  state.metrics.portfolio.availableCapitalUsd = 10_000;
  state.metrics.openPositions = [
    {
      instrumentId: 'ETH-PERP',
      side: 'long',
      size: '1',
      entryPrice: '2500',
      unrealizedPnlUsd: 12,
      openedAt: null,
      holdDurationMinutes: null,
      venueType: 'perps',
      freshness: { state: 'fresh' as const },
    },
  ];
  state.metrics.lastTechnicalScan = makeScan();
  return state;
}

describe('runHybridEvaluator', () => {
  beforeEach(() => {
    mockedCallLlmProvider.mockReset();
    logger.info.mockReset();
    logger.warn.mockReset();
    logger.error.mockReset();
  });

  it('injects available capital into the prompt and resolves symbol responses back to instrument ids', async () => {
    mockedCallLlmProvider.mockResolvedValue({
      ok: true,
      data: {
        content: '```json\n[{"symbol":"BTC","intent":"go_long","sizeUsd":250}]\n```',
        toolCalls: [],
        model: 'test-model',
        provider: 'test-provider',
        tokensUsed: 42,
        latencyMs: 12,
        cached: false,
      },
    } as Awaited<ReturnType<typeof callLlmProvider>>);

    const submitDecision = vi.fn().mockResolvedValue(undefined);

    await runHybridEvaluator({
      state: makeState(),
      llmConfig: { provider: 'test-provider', model: 'test-model', maxTokens: 500, timeoutMs: 1000 },
      maxPositions: 5,
      submitDecision,
      logger,
    });

    expect(submitDecision).toHaveBeenCalledWith('BTC-PERP', 'go_long', 250);

    const prompt = mockedCallLlmProvider.mock.calls[0]?.[1].messages[0]?.content;
    expect(prompt).toContain('Available capital: $10.0K');
    expect(prompt).toContain('| BTC-PERP | BTC | 0.92 |');
  });

  it('skips go_long responses that omit sizeUsd', async () => {
    mockedCallLlmProvider.mockResolvedValue({
      ok: true,
      data: {
        content: '[{"instrumentId":"BTC-PERP","intent":"go_long"}]',
        toolCalls: [],
        model: 'test-model',
        provider: 'test-provider',
        tokensUsed: 21,
        latencyMs: 8,
        cached: false,
      },
    } as Awaited<ReturnType<typeof callLlmProvider>>);

    const submitDecision = vi.fn().mockResolvedValue(undefined);

    const result = await runHybridEvaluator({
      state: makeState(),
      llmConfig: { provider: 'test-provider', model: 'test-model', maxTokens: 500, timeoutMs: 1000 },
      maxPositions: 5,
      submitDecision,
      logger,
    });

    expect(submitDecision).not.toHaveBeenCalled();
    expect(result.decisionsSubmitted).toBe(0);
    expect(result.decisionsSkipped).toBe(1);
    expect(result.errors).toContain('missing_size(BTC-PERP)');
  });

  it('renders flagged exit review context and submits go_flat decisions keyed by symbol', async () => {
    const state = makeState();
    state.metrics.openPositions = [
      {
        instrumentId: 'BTC',
        side: 'long',
        size: '1',
        entryPrice: '60000',
        unrealizedPnlUsd: 125,
        openedAt: null,
        holdDurationMinutes: null,
        venueType: 'perps',
        freshness: { state: 'fresh' as const },
      },
    ];
    state.metrics.lastTechnicalScan = {
      ...makeScan(),
      signals: [],
      positionIndicators: [
        {
          symbol: 'BTC',
          side: 'long',
          entryPrice: 60000,
          rsi: 84,
          signalNote: 'Overbought',
          exitAdvisory: true,
        },
      ],
    };

    mockedCallLlmProvider.mockResolvedValue({
      ok: true,
      data: {
        content: '[{"symbol":"BTC","intent":"go_flat"}]',
        toolCalls: [],
        model: 'test-model',
        provider: 'test-provider',
        tokensUsed: 17,
        latencyMs: 9,
        cached: false,
      },
    } as Awaited<ReturnType<typeof callLlmProvider>>);

    const submitDecision = vi.fn().mockResolvedValue(undefined);

    const result = await runHybridEvaluator({
      state,
      llmConfig: { provider: 'test-provider', model: 'test-model', maxTokens: 500, timeoutMs: 1000 },
      maxPositions: 5,
      submitDecision,
      logger,
    });

    expect(submitDecision).toHaveBeenCalledWith('BTC', 'go_flat', undefined);
    expect(result.decisionsSubmitted).toBe(1);
    expect(result.errors).toEqual([]);

    const prompt = mockedCallLlmProvider.mock.calls[0]?.[1].messages[0]?.content;
    expect(prompt).toContain('## Positions flagged for exit review');
    expect(prompt).toContain('| BTC | long | $60000.0000 | 84 | Overbought |');
    expect(prompt).toContain('respond with `go_flat` to exit or `hold` to keep');
  });

  it('skips evaluation when the latest technical scan is stale', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-06-22T12:00:00.000Z');
    vi.setSystemTime(now);

    const state = makeState();
    state.metrics.lastTechnicalScan = {
      ...makeScan(),
      timestamp: new Date(now.getTime() - (3 * 60_000)).toISOString(),
      scanIntervalMs: 60_000,
    };

    const submitDecision = vi.fn().mockResolvedValue(undefined);

    const result = await runHybridEvaluator({
      state,
      llmConfig: { provider: 'test-provider', model: 'test-model', maxTokens: 500, timeoutMs: 1000 },
      maxPositions: 5,
      submitDecision,
      logger,
    });

    expect(mockedCallLlmProvider).not.toHaveBeenCalled();
    expect(submitDecision).not.toHaveBeenCalled();
    expect(result.errors).toContain('stale_scan');
  });

  // 004: Cost invariant — hybrid evaluator is always single-shot regardless of signal count.
  it('makes exactly one LLM call even with multiple scanner signals (single-shot)', async () => {
    const state = makeState();
    // Simulate a scan with multiple signals — the evaluator must still produce one call.
    state.metrics.lastTechnicalScan = {
      ...makeScan(),
      signals: [
        { symbol: 'BTC', instrumentId: 'BTC-PERP', confidence: 0.92, reasons: ['RSI'], intent: 'go_long', indicators: {} },
        { symbol: 'ETH', instrumentId: 'ETH-PERP', confidence: 0.85, reasons: ['MACD'], intent: 'go_short', indicators: {} },
        { symbol: 'SOL', instrumentId: 'SOL-PERP', confidence: 0.78, reasons: ['volume'], intent: 'go_long', indicators: {} },
      ],
    };

    mockedCallLlmProvider.mockResolvedValue({
      ok: true,
      data: {
        content: '```json\n[]\n```',
        toolCalls: [],
        model: 'test-model',
        provider: 'test-provider',
        tokensUsed: 12,
        latencyMs: 8,
        cached: false,
      },
    } as Awaited<ReturnType<typeof callLlmProvider>>);

    const submitDecision = vi.fn().mockResolvedValue(undefined);

    await runHybridEvaluator({
      state,
      llmConfig: { provider: 'test-provider', model: 'test-model', maxTokens: 500, timeoutMs: 1000 },
      maxPositions: 5,
      submitDecision,
      logger,
    });

    expect(mockedCallLlmProvider).toHaveBeenCalledTimes(1);
  });
});

// ── Hybrid Prompt Enrichment ─────────────────────────────────────────────────

describe('buildHybridPrompt enrichments', () => {
  const scan = makeScan();
  const portfolio = {
    exposureUsd: 0,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    drawdownPct: 0,
    availableCapitalUsd: 10_000,
    netDelta: 0,
    freshness: { state: 'fresh' as const },
  };
  const openPositions: Array<{
    instrumentId: string; side: string; size: string; entryPrice: string | null;
    unrealizedPnlUsd: number | null; openedAt: string | null;
    holdDurationMinutes: number | null; venueType: 'perps' | 'dex' | 'unknown';
    freshness: { state: 'fresh' };
  }> = [];

  describe('## Agent Memory', () => {
    it('renders inline memory keys with values', () => {
      const prompt = buildHybridPrompt({
        scan, portfolio, openPositions, maxPositions: 5,
        agentMemory: {
          regime: { value: 'neutral' },
          sentiment: { value: { direction: 'bullish', score: 0.8 } },
        },
        maxInlineMemoryKeys: 12,
      });

      expect(prompt).toContain('## Agent Memory');
      expect(prompt).toContain('**regime**: neutral');
      expect(prompt).toContain('**sentiment**: {"direction":"bullish","score":0.8}');
    });

    it('renders overflow indicator when keys exceed maxInlineMemoryKeys', () => {
      const prompt = buildHybridPrompt({
        scan, portfolio, openPositions, maxPositions: 5,
        agentMemory: {
          key1: { value: 'v1' },
          key2: { value: 'v2' },
          key3: { value: 'v3' },
        },
        maxInlineMemoryKeys: 2,
      });

      expect(prompt).toContain('## Agent Memory');
      expect(prompt).toContain('Older keys:');
      expect(prompt).toContain('+1 more');
      expect(prompt).toContain('use list_memory_keys tool');
    });

    it('omits ## Agent Memory when agentMemory is null', () => {
      const prompt = buildHybridPrompt({
        scan, portfolio, openPositions, maxPositions: 5,
        agentMemory: null,
      });

      expect(prompt).not.toContain('## Agent Memory');
    });

    it('omits ## Agent Memory when agentMemory is empty object', () => {
      const prompt = buildHybridPrompt({
        scan, portfolio, openPositions, maxPositions: 5,
        agentMemory: {},
      });

      expect(prompt).not.toContain('## Agent Memory');
    });

    it('omits ## Agent Memory when agentMemory is undefined', () => {
      const prompt = buildHybridPrompt({
        scan, portfolio, openPositions, maxPositions: 5,
      });

      expect(prompt).not.toContain('## Agent Memory');
    });
  });

  describe('## Recent Agent Decisions', () => {
    it('renders judge response history with [Tick -N] labels', () => {
      const prompt = buildHybridPrompt({
        scan, portfolio, openPositions, maxPositions: 5,
        recentJudgeResponses: [
          'Skipped BONK — volume ratio below threshold. Exited JUP at $0.83 (+4.1%).',
          'Opened WIF long at $3.01. Regime pass. Passing on RAY (low ADX).',
        ],
      });

      expect(prompt).toContain('## Recent Agent Decisions');
      expect(prompt).toContain('[Tick -2]');
      expect(prompt).toContain('[Tick -1]');
      expect(prompt).toContain('Skipped BONK');
      expect(prompt).toContain('Opened WIF long');
    });

    it('truncates long responses to 120 chars', () => {
      const longResponse = 'A'.repeat(200);
      const prompt = buildHybridPrompt({
        scan, portfolio, openPositions, maxPositions: 5,
        recentJudgeResponses: [longResponse],
      });

      expect(prompt).toContain('## Recent Agent Decisions');
      expect(prompt).toContain('…');
      expect(prompt).not.toContain('A'.repeat(150));
    });

    it('omits ## Recent Agent Decisions when history is empty', () => {
      const prompt = buildHybridPrompt({
        scan, portfolio, openPositions, maxPositions: 5,
        recentJudgeResponses: [],
      });

      expect(prompt).not.toContain('## Recent Agent Decisions');
    });

    it('omits ## Recent Agent Decisions when undefined', () => {
      const prompt = buildHybridPrompt({
        scan, portfolio, openPositions, maxPositions: 5,
      });

      expect(prompt).not.toContain('## Recent Agent Decisions');
    });
  });
});

// ── Hybrid evaluator routing (004) ───────────────────────────────────────────

describe('canRouteToHybridEvaluator', () => {
  const freshScan = makeScan();

  it('returns false when not hybrid', () => {
    expect(canRouteToHybridEvaluator({
      isHybrid: false,
      isScannerGated: false,
      hasTradingCapability: true,
      hasWakeSignal: true,
      isScannerWake: true,
      latestTechnicalScan: freshScan,
    })).toBe(false);
  });

  it('returns false when no trading capability', () => {
    expect(canRouteToHybridEvaluator({
      isHybrid: true,
      isScannerGated: false,
      hasTradingCapability: false,
      hasWakeSignal: true,
      isScannerWake: true,
      latestTechnicalScan: freshScan,
    })).toBe(false);
  });

  it('returns false when no wake signal', () => {
    expect(canRouteToHybridEvaluator({
      isHybrid: true,
      isScannerGated: false,
      hasTradingCapability: true,
      hasWakeSignal: false,
      isScannerWake: true,
      latestTechnicalScan: freshScan,
    })).toBe(false);
  });

  // ── scanner_gated ──────────────────────────────────────────────────────

  it('scanner_gated + scanner wake → true', () => {
    expect(canRouteToHybridEvaluator({
      isHybrid: true,
      isScannerGated: true,
      hasTradingCapability: true,
      hasWakeSignal: true,
      isScannerWake: true,
    })).toBe(true);
  });

  it('scanner_gated + non-scanner wake → false (suppression happens upstream)', () => {
    expect(canRouteToHybridEvaluator({
      isHybrid: true,
      isScannerGated: true,
      hasTradingCapability: true,
      hasWakeSignal: true,
      isScannerWake: false,
    })).toBe(false);
  });

  it('scanner_gated + reminder wake → false (falls through to scout/judge)', () => {
    // Reminders set hasWakeSignal=true but currentMarketWake=null → isScannerWake=false
    expect(canRouteToHybridEvaluator({
      isHybrid: true,
      isScannerGated: true,
      hasTradingCapability: true,
      hasWakeSignal: true,
      isScannerWake: false,
    })).toBe(false);
  });

  it('scanner_gated + no wake signal → false', () => {
    expect(canRouteToHybridEvaluator({
      isHybrid: true,
      isScannerGated: true,
      hasTradingCapability: true,
      hasWakeSignal: false,
      isScannerWake: false,
    })).toBe(false);
  });

  // ── mixed ──────────────────────────────────────────────────────────────

  it('mixed + scanner wake + fresh scan → true', () => {
    expect(canRouteToHybridEvaluator({
      isHybrid: true,
      isScannerGated: false,
      hasTradingCapability: true,
      hasWakeSignal: true,
      isScannerWake: true,
      latestTechnicalScan: freshScan,
    })).toBe(true);
  });

  it('mixed + scanner wake + stale scan → false', () => {
    // Use a fixed historical timestamp (1 year in the past) to guarantee staleness
    // regardless of real vs fake timers.
    const staleScan: TechnicalScanState = {
      ...freshScan,
      timestamp: new Date('2020-01-01T00:00:00.000Z').toISOString(),
      scanIntervalMs: 60_000,
    };
    expect(canRouteToHybridEvaluator({
      isHybrid: true,
      isScannerGated: false,
      hasTradingCapability: true,
      hasWakeSignal: true,
      isScannerWake: true,
      latestTechnicalScan: staleScan,
    })).toBe(false);
  });

  it('mixed + scanner wake + no scan → false', () => {
    expect(canRouteToHybridEvaluator({
      isHybrid: true,
      isScannerGated: false,
      hasTradingCapability: true,
      hasWakeSignal: true,
      isScannerWake: true,
      latestTechnicalScan: undefined,
    })).toBe(false);
  });

  it('mixed + non-scanner wake → false', () => {
    expect(canRouteToHybridEvaluator({
      isHybrid: true,
      isScannerGated: false,
      hasTradingCapability: true,
      hasWakeSignal: true,
      isScannerWake: false,
      latestTechnicalScan: freshScan,
    })).toBe(false);
  });

  it('mixed + no wake signal → false', () => {
    expect(canRouteToHybridEvaluator({
      isHybrid: true,
      isScannerGated: false,
      hasTradingCapability: true,
      hasWakeSignal: false,
      isScannerWake: true,
      latestTechnicalScan: freshScan,
    })).toBe(false);
  });
});

// ── Scanner wake → hybrid evaluator end-to-end chain ─────────────────────────

describe('scanner wake routes to single-shot hybrid evaluator', () => {
  beforeEach(() => {
    mockedCallLlmProvider.mockReset();
    logger.info.mockReset();
    logger.warn.mockReset();
    logger.error.mockReset();
  });

  it('ingests a scanner wake, routes via canRouteToHybridEvaluator, and submits decision with correct symbol', async () => {
    // Simulate: scanner produced a signal for BTC, runtime ingested it,
    // now a scanner wake arrives → hybrid evaluator runs single-shot.
    const state = createRuntimeCompositionState(baseDescriptor);
    state.metrics.portfolio.availableCapitalUsd = 10_000;
    state.metrics.lastTechnicalScan = {
      ...makeScan(),
      signals: [
        {
          symbol: 'BTC',
          instrumentId: 'BTC-PERP',
          confidence: 0.92,
          reasons: ['RSI healthy', 'volume strong'],
          intent: 'go_long',
          indicators: { rsi: 58, macdHistogram: 1.2, volumeRatio: 1.8 },
        },
      ],
      signalsGenerated: 1,
    };

    // Verify routing: scanner_gated + scanner wake → true
    const routingResult = canRouteToHybridEvaluator({
      isHybrid: true,
      isScannerGated: true,
      hasTradingCapability: true,
      hasWakeSignal: true,
      isScannerWake: true,
    });
    expect(routingResult).toBe(true);

    // Mock LLM response: LLM decides to go_long BTC
    mockedCallLlmProvider.mockResolvedValue({
      ok: true,
      data: {
        content: '```json\n[{"symbol":"BTC","intent":"go_long","sizeUsd":500}]\n```',
        toolCalls: [],
        model: 'test-model',
        provider: 'test-provider',
        tokensUsed: 42,
        latencyMs: 12,
        cached: false,
      },
    } as Awaited<ReturnType<typeof callLlmProvider>>);

    const submitDecision = vi.fn().mockResolvedValue(undefined);

    const result = await runHybridEvaluator({
      state,
      llmConfig: { provider: 'test-provider', model: 'test-model', maxTokens: 500, timeoutMs: 1000 },
      maxPositions: 5,
      submitDecision,
      logger,
    });

    // The LLM responded with symbol "BTC" → should resolve to "BTC-PERP" from the scan
    expect(submitDecision).toHaveBeenCalledWith('BTC-PERP', 'go_long', 500);
    expect(result.decisionsSubmitted).toBe(1);
    expect(result.errors).toEqual([]);
  });
});