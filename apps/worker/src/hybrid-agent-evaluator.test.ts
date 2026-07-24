import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callLlmProvider } from '@herobids/llm';
import { runHybridEvaluator, canRouteToHybridEvaluator } from './hybrid-agent-evaluator.js';
import { createRuntimeCompositionState, type HybridPricingIdentity, type RuntimeVenueSignal, type TechnicalScanState } from './runtime-composition.js';
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
    pricingIdentities: {
      'BTC-PERP': { kind: 'perps', symbol: 'BTC', chain: 'hyperliquid' },
    },
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

    const submitDecision = vi.fn().mockResolvedValue('mock-decision-id');

    await runHybridEvaluator({
      state: makeState(),
      llmConfig: { provider: 'test-provider', model: 'test-model', maxTokens: 500, timeoutMs: 1000 },
      maxPositions: 5,
      submitDecision,
      logger,
    });

    expect(submitDecision).toHaveBeenCalledWith('BTC-PERP', 'go_long', 250, {
      kind: 'perps',
      symbol: 'BTC',
      chain: 'hyperliquid',
    });

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

    const submitDecision = vi.fn().mockResolvedValue('mock-decision-id');

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

    const submitDecision = vi.fn().mockResolvedValue('mock-decision-id');

    const result = await runHybridEvaluator({
      state,
      llmConfig: { provider: 'test-provider', model: 'test-model', maxTokens: 500, timeoutMs: 1000 },
      maxPositions: 5,
      submitDecision,
      logger,
    });

    // go_flat from a position-indicator match (no signal → no pricing identity)
    expect(submitDecision).toHaveBeenCalledWith('BTC', 'go_flat', undefined, undefined);
    expect(result.decisionsSubmitted).toBe(1);
    expect(result.errors).toEqual([]);

    const prompt = mockedCallLlmProvider.mock.calls[0]?.[1].messages[0]?.content;
    expect(prompt).toContain('## Positions flagged for exit review');
    expect(prompt).toContain('| BTC | long | $60000.0000 | $60125.0000 | $125 | — | 84 | Overbought |');
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

    const submitDecision = vi.fn().mockResolvedValue('mock-decision-id');

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

    const submitDecision = vi.fn().mockResolvedValue('mock-decision-id');

    await runHybridEvaluator({
      state,
      llmConfig: { provider: 'test-provider', model: 'test-model', maxTokens: 500, timeoutMs: 1000 },
      maxPositions: 5,
      submitDecision,
      logger,
    });

    expect(mockedCallLlmProvider).toHaveBeenCalledTimes(1);
  });

  // 002-hybrid-usd-to-base: regression test proving hybrid go_long decisions
  // carry pricing identity through to the submitDecision callback.
  it('passes pricing identity to submitDecision when scan has pricingIdentities', async () => {
    const state = makeState();
    const pricingIdentity: HybridPricingIdentity = {
      kind: 'perps',
      symbol: 'BTC',
      chain: 'hyperliquid',
    };
    state.metrics.lastTechnicalScan = {
      ...makeScan(),
      pricingIdentities: {
        'BTC-PERP': pricingIdentity,
      },
    };

    mockedCallLlmProvider.mockResolvedValue({
      ok: true,
      data: {
        content: '```json\n[{"symbol":"BTC","intent":"go_long","sizeUsd":100}]\n```',
        toolCalls: [],
        model: 'test-model',
        provider: 'test-provider',
        tokensUsed: 42,
        latencyMs: 12,
        cached: false,
      },
    } as Awaited<ReturnType<typeof callLlmProvider>>);

    const submitDecision = vi.fn().mockResolvedValue('mock-decision-id');

    await runHybridEvaluator({
      state,
      llmConfig: { provider: 'test-provider', model: 'test-model', maxTokens: 500, timeoutMs: 1000 },
      maxPositions: 5,
      submitDecision,
      logger,
    });

    expect(submitDecision).toHaveBeenCalledWith('BTC-PERP', 'go_long', 100, pricingIdentity);
  });

  // 002-hybrid-usd-to-base: regression test — direct instrumentId match
  // (no symbol resolution needed) also passes pricing identity.
  it('passes pricing identity for direct instrumentId matches', async () => {
    const state = makeState();
    const pricingIdentity: HybridPricingIdentity = {
      kind: 'perps',
      symbol: 'ETH',
      chain: 'hyperliquid',
    };
    state.metrics.lastTechnicalScan = {
      ...makeScan(),
      pricingIdentities: {
        'ETH-PERP': pricingIdentity,
      },
    };

    mockedCallLlmProvider.mockResolvedValue({
      ok: true,
      data: {
        content: '[{"instrumentId":"ETH-PERP","intent":"go_long","sizeUsd":300}]',
        toolCalls: [],
        model: 'test-model',
        provider: 'test-provider',
        tokensUsed: 42,
        latencyMs: 12,
        cached: false,
      },
    } as Awaited<ReturnType<typeof callLlmProvider>>);

    const submitDecision = vi.fn().mockResolvedValue('mock-decision-id');

    await runHybridEvaluator({
      state,
      llmConfig: { provider: 'test-provider', model: 'test-model', maxTokens: 500, timeoutMs: 1000 },
      maxPositions: 5,
      submitDecision,
      logger,
    });

    expect(submitDecision).toHaveBeenCalledWith('ETH-PERP', 'go_long', 300, pricingIdentity);
  });

  it('calls onArtifact with submitted decision IDs on success', async () => {
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

    const submitDecision = vi.fn().mockResolvedValue('decision-abc-123');
    const onArtifact = vi.fn().mockResolvedValue(undefined);

    await runHybridEvaluator({
      state: makeState(),
      llmConfig: { provider: 'test-provider', model: 'test-model', maxTokens: 500, timeoutMs: 1000 },
      maxPositions: 5,
      submitDecision,
      onArtifact,
      logger,
    });

    expect(onArtifact).toHaveBeenCalledTimes(1);
    const artifactArg = onArtifact.mock.calls[0]?.[0];
    expect(artifactArg.source).toBe('hybrid_evaluator');
    expect(artifactArg.decisionIds).toEqual(['decision-abc-123']);
    expect(artifactArg.parseStatus).toBe('success');
    expect(artifactArg.rawResponse).toBe('```json\n[{"symbol":"BTC","intent":"go_long","sizeUsd":250}]\n```');
    expect(artifactArg.provider).toBe('test-provider');
    expect(artifactArg.model).toBe('test-model');
    expect(artifactArg.tokensUsed).toBe(42);
    expect(artifactArg.latencyMs).toBe(12);
    expect(artifactArg.cached).toBe(false);
  });

  it('calls onArtifact with parseStatus provider_error when the LLM call throws', async () => {
    mockedCallLlmProvider.mockRejectedValue(new Error('Network timeout'));

    const submitDecision = vi.fn().mockResolvedValue('mock-decision-id');
    const onArtifact = vi.fn().mockResolvedValue(undefined);

    const result = await runHybridEvaluator({
      state: makeState(),
      llmConfig: { provider: 'test-provider', model: 'test-model', maxTokens: 500, timeoutMs: 1000 },
      maxPositions: 5,
      submitDecision,
      onArtifact,
      logger,
    });

    expect(onArtifact).toHaveBeenCalledTimes(1);
    const artifactArg = onArtifact.mock.calls[0]?.[0];
    expect(artifactArg.source).toBe('hybrid_evaluator');
    expect(artifactArg.parseStatus).toBe('provider_error');
    expect(artifactArg.parseError).toBe('Network timeout');
    expect(artifactArg.decisionIds).toEqual([]);
    expect(artifactArg.rawResponse).toBeNull();
    expect(artifactArg.cached).toBe(false);
    expect(result.errors.some((e) => e.startsWith('llm_call_failed'))).toBe(true);
  });

  it('calls onArtifact with parseStatus parse_error when the LLM response is malformed JSON', async () => {
    mockedCallLlmProvider.mockResolvedValue({
      ok: true,
      data: {
        content: 'not valid json at all',
        toolCalls: [],
        model: 'test-model',
        provider: 'test-provider',
        tokensUsed: 15,
        latencyMs: 7,
        cached: false,
      },
    } as Awaited<ReturnType<typeof callLlmProvider>>);

    const submitDecision = vi.fn().mockResolvedValue('mock-decision-id');
    const onArtifact = vi.fn().mockResolvedValue(undefined);

    const result = await runHybridEvaluator({
      state: makeState(),
      llmConfig: { provider: 'test-provider', model: 'test-model', maxTokens: 500, timeoutMs: 1000 },
      maxPositions: 5,
      submitDecision,
      onArtifact,
      logger,
    });

    expect(onArtifact).toHaveBeenCalledTimes(1);
    const artifactArg = onArtifact.mock.calls[0]?.[0];
    expect(artifactArg.source).toBe('hybrid_evaluator');
    expect(artifactArg.parseStatus).toBe('parse_error');
    expect(artifactArg.decisionIds).toEqual([]);
    expect(artifactArg.rawResponse).toBe('not valid json at all');
    expect(artifactArg.cached).toBe(false);
    expect(result.errors.some((e) => e.startsWith('parse_failed'))).toBe(true);
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

    const submitDecision = vi.fn().mockResolvedValue('mock-decision-id');

    const result = await runHybridEvaluator({
      state,
      llmConfig: { provider: 'test-provider', model: 'test-model', maxTokens: 500, timeoutMs: 1000 },
      maxPositions: 5,
      submitDecision,
      logger,
    });

    // The LLM responded with symbol "BTC" → should resolve to "BTC-PERP" from the scan
    expect(submitDecision).toHaveBeenCalledWith('BTC-PERP', 'go_long', 500, {
      kind: 'perps',
      symbol: 'BTC',
      chain: 'hyperliquid',
    });
    expect(result.decisionsSubmitted).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('symbol-based resolution preserves Bybit pricing identity (not hardcoded Hyperliquid)', async () => {
    const state = createRuntimeCompositionState(baseDescriptor);
    state.metrics.portfolio.availableCapitalUsd = 10_000;
    state.metrics.lastTechnicalScan = {
      ...makeScan(),
      signals: [
        {
          symbol: 'BTC',
          instrumentId: 'BTCUSDT',
          confidence: 0.88,
          reasons: ['RSI healthy', 'MACD crossover'],
          intent: 'go_long',
          indicators: { rsi: 55, macdHistogram: 0.3, volumeRatio: 1.5 },
        },
      ],
      signalsGenerated: 1,
      pricingIdentities: {
        'BTCUSDT': { kind: 'perps', symbol: 'BTCUSDT', chain: 'bybit' },
      },
    };

    mockedCallLlmProvider.mockResolvedValue({
      ok: true,
      data: {
        content: '```json\n[{"symbol":"BTC","intent":"go_long","sizeUsd":300}]\n```',
        toolCalls: [],
        model: 'test-model',
        provider: 'test-provider',
        tokensUsed: 42,
        latencyMs: 12,
        cached: false,
      },
    } as Awaited<ReturnType<typeof callLlmProvider>>);

    const submitDecision = vi.fn().mockResolvedValue('mock-decision-id');

    const result = await runHybridEvaluator({
      state,
      llmConfig: { provider: 'test-provider', model: 'test-model', maxTokens: 500, timeoutMs: 1000 },
      maxPositions: 5,
      submitDecision,
      logger,
    });

    // Symbol "BTC" resolves to instrument "BTCUSDT" with Bybit pricing identity
    expect(submitDecision).toHaveBeenCalledWith('BTCUSDT', 'go_long', 300, {
      kind: 'perps',
      symbol: 'BTCUSDT',
      chain: 'bybit',
    });
    expect(result.decisionsSubmitted).toBe(1);
  });
});

// ── Phase 1: Venue Intelligence ─────────────────────────────────────────────

describe('buildHybridPrompt venue intelligence (Phase 1)', () => {
  const scan = makeScan();
  const portfolio = {
    exposureUsd: 0, realizedPnlUsd: 0, unrealizedPnlUsd: 0, drawdownPct: 0,
    availableCapitalUsd: 10_000, netDelta: 0, freshness: { state: 'fresh' as const },
  };
  const openPositions: Array<{
    instrumentId: string; side: string; size: string; entryPrice: string | null;
    unrealizedPnlUsd: number | null; openedAt: string | null;
    holdDurationMinutes: number | null; venueType: 'perps' | 'dex' | 'unknown';
    freshness: { state: 'fresh' };
  }> = [];

  it('renders venue intelligence table when venueSignals match via pricingIdentities', () => {
    const venueSignals: RuntimeVenueSignal[] = [
      {
        kind: 'perps', instrument: 'BTC', venue: 'hyperliquid',
        fields: [
          { label: 'Funding', value: '0.0100%' },
          { label: 'Open interest', value: '12345.67' },
          { label: '24h volume', value: '$45000000' },
          { label: '24h change', value: '+12.34%' },
        ],
        freshness: { state: 'fresh' },
      },
    ];

    const prompt = buildHybridPrompt({
      scan: {
        ...scan,
        pricingIdentities: {
          'BTC-PERP': { kind: 'perps', symbol: 'BTC', chain: 'hyperliquid' },
        },
      },
      portfolio, openPositions, maxPositions: 5,
      venueSignals,
    });

    expect(prompt).toContain('## Venue Intelligence');
    expect(prompt).toContain('| Instrument ID | Funding Rate | 24h Change | 24h Volume | Open Interest |');
    expect(prompt).toContain('| BTC-PERP | 0.0100% | +12.34% | $45000000 | 12345.67 |');
  });

  it('uses instrumentId as the table key (not base symbol)', () => {
    const venueSignals: RuntimeVenueSignal[] = [
      {
        kind: 'perps', instrument: 'BTC', venue: 'hyperliquid',
        fields: [
          { label: 'Funding', value: '0.0100%' },
          { label: 'Open interest', value: '1000' },
          { label: '24h volume', value: '$1M' },
          { label: '24h change', value: '+5%' },
        ],
        freshness: { state: 'fresh' },
      },
    ];

    const prompt = buildHybridPrompt({
      scan: {
        ...scan,
        pricingIdentities: {
          'BTC-PERP': { kind: 'perps', symbol: 'BTC', chain: 'hyperliquid' },
        },
      },
      portfolio, openPositions, maxPositions: 5,
      venueSignals,
    });

    // The table key must be BTC-PERP (instrumentId), not BTC (base symbol).
    expect(prompt).toContain('| BTC-PERP |');
    expect(prompt).not.toContain('| BTC | 0.0100%');
  });

  it('shows — fallback for instruments with no matching venue signal', () => {
    const venueSignals: RuntimeVenueSignal[] = [
      {
        kind: 'perps', instrument: 'BTC', venue: 'hyperliquid',
        fields: [
          { label: 'Funding', value: '0.0100%' },
          { label: 'Open interest', value: '1000' },
          { label: '24h volume', value: '$1M' },
          { label: '24h change', value: '+5%' },
        ],
        freshness: { state: 'fresh' },
      },
    ];

    const prompt = buildHybridPrompt({
      scan: {
        ...scan,
        // BTC-PERP has a pricing identity but ETH-PERP does not — both should appear
        // since both are signal instruments, but ETH-PERP gets — fallbacks.
        signals: [
          { symbol: 'BTC', instrumentId: 'BTC-PERP', confidence: 0.92, reasons: ['RSI'], intent: 'go_long', indicators: { rsi: 58 } },
          { symbol: 'ETH', instrumentId: 'ETH-PERP', confidence: 0.85, reasons: ['MACD'], intent: 'go_long', indicators: { rsi: 45 } },
        ],
        pricingIdentities: {
          'BTC-PERP': { kind: 'perps', symbol: 'BTC', chain: 'hyperliquid' },
        },
      },
      portfolio, openPositions, maxPositions: 5,
      venueSignals,
    });

    expect(prompt).toContain('## Venue Intelligence');
    expect(prompt).toContain('| BTC-PERP | 0.0100%');
    // ETH-PERP should have — in all venue columns
    expect(prompt).toContain('| ETH-PERP | — | — | — | — |');
  });

  it('renders staleness markers on stale venue signals', () => {
    const venueSignals: RuntimeVenueSignal[] = [
      {
        kind: 'perps', instrument: 'BTC', venue: 'hyperliquid',
        fields: [
          { label: 'Funding', value: '0.0100%' },
          { label: 'Open interest', value: '1000' },
          { label: '24h volume', value: '$1M' },
          { label: '24h change', value: '+5%' },
        ],
        freshness: { state: 'stale', ageMs: 480_000 },
      },
    ];

    const prompt = buildHybridPrompt({
      scan: {
        ...scan,
        pricingIdentities: {
          'BTC-PERP': { kind: 'perps', symbol: 'BTC', chain: 'hyperliquid' },
        },
      },
      portfolio, openPositions, maxPositions: 5,
      venueSignals,
    });

    expect(prompt).toContain('## Venue Intelligence');
    expect(prompt).toContain('0.0100% (stale 8m)');
    expect(prompt).toContain('+5% (stale 8m)');
  });

  it('omits venue intelligence section when no relevant instruments match', () => {
    const venueSignals: RuntimeVenueSignal[] = [
      {
        kind: 'perps', instrument: 'SOL', venue: 'hyperliquid',
        fields: [
          { label: 'Funding', value: '0.0050%' },
          { label: 'Open interest', value: '500' },
          { label: '24h volume', value: '$500K' },
          { label: '24h change', value: '-2%' },
        ],
        freshness: { state: 'fresh' },
      },
    ];

    const prompt = buildHybridPrompt({
      scan: {
        ...scan,
        // BTC-PERP signal but no matching venue signal (only SOL available)
        signals: [
          { symbol: 'BTC', instrumentId: 'BTC-PERP', confidence: 0.92, reasons: ['RSI'], intent: 'go_long', indicators: { rsi: 58 } },
        ],
        pricingIdentities: {
          'BTC-PERP': { kind: 'perps', symbol: 'BTC', chain: 'hyperliquid' },
        },
      },
      portfolio, openPositions, maxPositions: 5,
      venueSignals,
    });

    expect(prompt).not.toContain('## Venue Intelligence');
  });

  it('omits venue intelligence section when venueSignals is undefined', () => {
    const prompt = buildHybridPrompt({
      scan, portfolio, openPositions, maxPositions: 5,
    });

    expect(prompt).not.toContain('## Venue Intelligence');
  });

  it('omits venue intelligence section when venueSignals is empty', () => {
    const prompt = buildHybridPrompt({
      scan, portfolio, openPositions, maxPositions: 5,
      venueSignals: [],
    });

    expect(prompt).not.toContain('## Venue Intelligence');
  });

  it('includes open-position instruments in venue intelligence', () => {
    const venueSignals: RuntimeVenueSignal[] = [
      {
        kind: 'perps', instrument: 'ETH', venue: 'hyperliquid',
        fields: [
          { label: 'Funding', value: '0.0200%' },
          { label: 'Open interest', value: '5000' },
          { label: '24h volume', value: '$20M' },
          { label: '24h change', value: '-3.5%' },
        ],
        freshness: { state: 'fresh' },
      },
    ];

    const prompt = buildHybridPrompt({
      scan: {
        ...scan,
        signals: [], // No signals — only open positions drive the table
        pricingIdentities: {
          'ETH-PERP': { kind: 'perps', symbol: 'ETH', chain: 'hyperliquid' },
        },
      },
      portfolio,
      openPositions: [
        { instrumentId: 'ETH-PERP', side: 'long', size: '1', entryPrice: '3000', unrealizedPnlUsd: 50, openedAt: null, holdDurationMinutes: 120, venueType: 'perps', freshness: { state: 'fresh' } },
      ],
      maxPositions: 5,
      venueSignals,
    });

    expect(prompt).toContain('## Venue Intelligence');
    expect(prompt).toContain('| ETH-PERP | 0.0200% | -3.5% | $20M | 5000 |');
  });

  it('matches Bybit pricing identity (full ticker symbol) to base-symbol venue signal', () => {
    const venueSignals: RuntimeVenueSignal[] = [
      {
        kind: 'perps', instrument: 'BTC', venue: 'hyperliquid+bybit',
        fields: [
          { label: 'Funding', value: '0.0050%' },
          { label: 'Open interest', value: '9999' },
          { label: '24h volume', value: '$80M' },
          { label: '24h change', value: '+3.2%' },
        ],
        freshness: { state: 'fresh' },
      },
    ];

    const prompt = buildHybridPrompt({
      scan: {
        ...scan,
        pricingIdentities: {
          // Bybit stores the full market ticker as the pricing-identity symbol.
          'BTCUSDT': { kind: 'perps', symbol: 'BTCUSDT', chain: 'bybit' },
        },
        signals: [
          { symbol: 'BTC', instrumentId: 'BTCUSDT', confidence: 0.88, reasons: ['MACD'], intent: 'go_long', indicators: { rsi: 55 } },
        ],
      },
      portfolio, openPositions, maxPositions: 5,
      venueSignals,
    });

    expect(prompt).toContain('## Venue Intelligence');
    expect(prompt).toContain('| BTCUSDT | 0.0050% | +3.2% | $80M | 9999 |');
  });

  it('matches DEX venue signal ("SYMBOL (network)" format)', () => {
    const venueSignals: RuntimeVenueSignal[] = [
      {
        kind: 'dex', instrument: 'BONK (solana)', venue: 'dexscreener',
        fields: [
          { label: 'Funding', value: 'unavailable' },
          { label: 'Open interest', value: 'unavailable' },
          { label: '24h volume', value: '$1.2M' },
          { label: '24h change', value: '+8.5%' },
        ],
        freshness: { state: 'fresh' },
      },
    ];

    const prompt = buildHybridPrompt({
      scan: {
        ...scan,
        pricingIdentities: {
          'BONK-DEX': { kind: 'dex', symbol: 'BONK', chain: 'solana' },
        },
        signals: [
          { symbol: 'BONK', instrumentId: 'BONK-DEX', confidence: 0.78, reasons: ['volume'], intent: 'go_long', indicators: { rsi: 48 } },
        ],
      },
      portfolio, openPositions, maxPositions: 5,
      venueSignals,
    });

    expect(prompt).toContain('## Venue Intelligence');
    // DEX instruments don't have Funding or Open Interest — those show the field value as-is.
    expect(prompt).toContain('| BONK-DEX | unavailable');
    expect(prompt).toContain('+8.5%');
    expect(prompt).toContain('$1.2M');
  });

  it('matches the correct DEX network when multiple venue rows share the same symbol', () => {
    const venueSignals: RuntimeVenueSignal[] = [
      {
        kind: 'dex', instrument: 'BONK (base)', venue: 'dexscreener',
        fields: [
          { label: 'Funding', value: 'unavailable' },
          { label: 'Open interest', value: 'unavailable' },
          { label: '24h volume', value: '$800K' },
          { label: '24h change', value: '-2.0%' },
        ],
        freshness: { state: 'fresh' },
      },
      {
        kind: 'dex', instrument: 'BONK (solana)', venue: 'dexscreener',
        fields: [
          { label: 'Funding', value: 'unavailable' },
          { label: 'Open interest', value: 'unavailable' },
          { label: '24h volume', value: '$1.2M' },
          { label: '24h change', value: '+8.5%' },
        ],
        freshness: { state: 'fresh' },
      },
    ];

    const prompt = buildHybridPrompt({
      scan: {
        ...scan,
        pricingIdentities: {
          'BONK-DEX': { kind: 'dex', symbol: 'BONK', chain: 'solana' },
        },
        signals: [
          { symbol: 'BONK', instrumentId: 'BONK-DEX', confidence: 0.78, reasons: ['volume'], intent: 'go_long', indicators: { rsi: 48 } },
        ],
      },
      portfolio, openPositions, maxPositions: 5,
      venueSignals,
    });

    expect(prompt).toContain('## Venue Intelligence');
    expect(prompt).toContain('| BONK-DEX | unavailable | +8.5% | $1.2M | unavailable |');
    expect(prompt).not.toContain('| BONK-DEX | unavailable | -2.0% | $800K | unavailable |');
  });
});

// ── Phase 2: Richer Exit Review ──────────────────────────────────────────────

describe('buildHybridPrompt exit review enrichment (Phase 2)', () => {
  const baseScan = makeScan();
  const portfolio = {
    exposureUsd: 0, realizedPnlUsd: 0, unrealizedPnlUsd: 0, drawdownPct: 0,
    availableCapitalUsd: 10_000, netDelta: 0, freshness: { state: 'fresh' as const },
  };

  it('renders P&L, hold duration, and current price for matched open positions', () => {
    const scan: TechnicalScanState = {
      ...baseScan,
      signals: [],
      positionIndicators: [
        { symbol: 'ETH', side: 'long', entryPrice: 3000, rsi: 72, signalNote: 'Overbought', exitAdvisory: true },
      ],
    };
    const openPositions = [
      { instrumentId: 'ETH', side: 'long', size: '2', entryPrice: '3000', unrealizedPnlUsd: 150, openedAt: '2026-07-17T00:00:00Z', holdDurationMinutes: 45, venueType: 'perps' as const, freshness: { state: 'fresh' as const } },
    ];

    const prompt = buildHybridPrompt({ scan, portfolio, openPositions, maxPositions: 5 });

    expect(prompt).toContain('| Instrument ID | Side | Entry | Current | P&L | Hold | RSI | Signal Note |');
    expect(prompt).toContain('| ETH | long | $3000.0000 |');
    expect(prompt).toContain('$150');
    expect(prompt).toContain('45m');
    expect(prompt).toContain('72');
    expect(prompt).toContain('Overbought');
  });

  it('uses currentPrice from PositionIndicatorUpdate when available', () => {
    const scan: TechnicalScanState = {
      ...baseScan,
      signals: [],
      positionIndicators: [
        { symbol: 'ETH', side: 'long', entryPrice: 3000, currentPrice: 3075, rsi: 72, signalNote: 'Overbought', exitAdvisory: true },
      ],
    };
    const openPositions = [
      { instrumentId: 'ETH', side: 'long', size: '2', entryPrice: '3000', unrealizedPnlUsd: 150, openedAt: '2026-07-17T00:00:00Z', holdDurationMinutes: 45, venueType: 'perps' as const, freshness: { state: 'fresh' as const } },
    ];

    const prompt = buildHybridPrompt({ scan, portfolio, openPositions, maxPositions: 5 });

    expect(prompt).toContain('$3075.0000');
  });

  it('shows — fallback when no matching open position is found', () => {
    const scan: TechnicalScanState = {
      ...baseScan,
      signals: [],
      positionIndicators: [
        { symbol: 'SOL', side: 'long', entryPrice: 150, rsi: 65, signalNote: 'Taking profit', exitAdvisory: true },
      ],
    };
    const openPositions: Array<{
      instrumentId: string; side: string; size: string; entryPrice: string | null;
      unrealizedPnlUsd: number | null; openedAt: string | null;
      holdDurationMinutes: number | null; venueType: 'perps' | 'dex' | 'unknown';
      freshness: { state: 'fresh' };
    }> = [];

    const prompt = buildHybridPrompt({ scan, portfolio, openPositions, maxPositions: 5 });

    expect(prompt).toContain('| Instrument ID | Side | Entry | Current | P&L | Hold | RSI | Signal Note |');
    // Current, P&L, Hold should all be —
    expect(prompt).toMatch(/\| SOL \| long \| \$150\.0000 \| — \| — \| — \| 65 \| Taking profit \|/);
  });

  it('matches positionIndicators to openPositions by instrumentId when available', () => {
    const scan: TechnicalScanState = {
      ...baseScan,
      signals: [],
      positionIndicators: [
        { symbol: 'ETH', instrumentId: 'ETH-PERP', side: 'long', entryPrice: 3000, rsi: 70, signalNote: 'Exit signal', exitAdvisory: true },
      ],
    };
    const openPositions = [
      { instrumentId: 'ETH-PERP', side: 'long', size: '1', entryPrice: '3000', unrealizedPnlUsd: 100, openedAt: '2026-07-17T00:00:00Z', holdDurationMinutes: 30, venueType: 'perps' as const, freshness: { state: 'fresh' as const } },
    ];

    const prompt = buildHybridPrompt({ scan, portfolio, openPositions, maxPositions: 5 });

    expect(prompt).toContain('$100');
    expect(prompt).toContain('30m');
  });
});

// ── Phase 3: Scanner Rejection Landscape ─────────────────────────────────────

describe('buildHybridPrompt rejection landscape (Phase 3)', () => {
  const portfolio = {
    exposureUsd: 0, realizedPnlUsd: 0, unrealizedPnlUsd: 0, drawdownPct: 0,
    availableCapitalUsd: 10_000, netDelta: 0, freshness: { state: 'fresh' as const },
  };
  const openPositions: Array<{
    instrumentId: string; side: string; size: string; entryPrice: string | null;
    unrealizedPnlUsd: number | null; openedAt: string | null;
    holdDurationMinutes: number | null; venueType: 'perps' | 'dex' | 'unknown';
    freshness: { state: 'fresh' };
  }> = [];

  it('renders rejection breakdown from symbolOutcomes with various statuses', () => {
    const scan: TechnicalScanState = {
      ...makeScan(),
      symbolOutcomes: [
        { symbol: 'BTC', status: 'eligible_fetched', candleCount: 100 },
        { symbol: 'ETH', status: 'unsupported' },
        { symbol: 'SOL', status: 'unsupported' },
        { symbol: 'AVAX', status: 'eligible_empty', candleCount: 0 },
        { symbol: 'ARB', status: 'eligible_empty', candleCount: 0 },
        { symbol: 'OP', status: 'eligible_empty', candleCount: 0 },
        { symbol: 'MATIC', status: 'transient_failure', errorDetail: 'timeout' },
        { symbol: 'ATOM', status: 'transient_failure', errorDetail: 'rate limit' },
      ],
      summary: { scanned: 8, rejected: 7, passed: 1 },
      fetched: 1, unsupported: 2, eligible: 6, fetchFailures: 2,
    };

    const prompt = buildHybridPrompt({ scan, portfolio, openPositions, maxPositions: 5 });

    expect(prompt).toContain('8 instruments scanned, 7 rejected (1 passed filters)');
    expect(prompt).toContain('Rejection breakdown: 2 unsupported, 3 no candle data, 2 fetch failure');
  });

  it('renders only applicable rejection categories', () => {
    const scan: TechnicalScanState = {
      ...makeScan(),
      symbolOutcomes: [
        { symbol: 'BTC', status: 'eligible_fetched', candleCount: 100 },
        { symbol: 'ETH', status: 'unsupported' },
      ],
      summary: { scanned: 2, rejected: 1, passed: 1 },
      fetched: 1, unsupported: 1, eligible: 1, fetchFailures: 0,
    };

    const prompt = buildHybridPrompt({ scan, portfolio, openPositions, maxPositions: 5 });

    expect(prompt).toContain('Rejection breakdown: 1 unsupported');
    expect(prompt).not.toContain('no candle data');
    expect(prompt).not.toContain('fetch failure');
  });

  it('falls back to bare summary when symbolOutcomes is empty', () => {
    const scan: TechnicalScanState = {
      ...makeScan(),
      symbolOutcomes: [],
      summary: { scanned: 20, rejected: 17, passed: 3 },
    };

    const prompt = buildHybridPrompt({ scan, portfolio, openPositions, maxPositions: 5 });

    expect(prompt).toContain('20 instruments scanned, 17 rejected (3 passed filters)');
    expect(prompt).not.toContain('Rejection breakdown:');
  });
});

// ── Phase 4: Optional reason field ───────────────────────────────────────────

import { HybridAgentDecisionSchema } from '@herobids/domain';

describe('HybridAgentDecisionSchema reason field (Phase 4)', () => {
  it('accepts a decision with a reason', () => {
    const result = HybridAgentDecisionSchema.safeParse({
      instrumentId: 'SOL-PERP',
      intent: 'go_long',
      sizeUsd: 50,
      reason: 'high confidence, strong volume',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reason).toBe('high confidence, strong volume');
    }
  });

  it('accepts a decision without a reason (backward-compatible)', () => {
    const result = HybridAgentDecisionSchema.safeParse({
      instrumentId: 'SOL-PERP',
      intent: 'go_long',
      sizeUsd: 50,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reason).toBeUndefined();
    }
  });

  it('accepts a decision with an empty string reason', () => {
    const result = HybridAgentDecisionSchema.safeParse({
      instrumentId: 'SOL-PERP',
      intent: 'skip',
      reason: '',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a skip decision with reason', () => {
    const result = HybridAgentDecisionSchema.safeParse({
      instrumentId: 'ETH-PERP',
      intent: 'skip',
      reason: 'low confidence (0.40)',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a go_flat decision with reason', () => {
    const result = HybridAgentDecisionSchema.safeParse({
      instrumentId: 'BTC-PERP',
      intent: 'go_flat',
      reason: 'stop loss triggered',
    });
    expect(result.success).toBe(true);
  });
});