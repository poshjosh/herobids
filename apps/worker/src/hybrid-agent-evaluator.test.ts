import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callLlmProvider } from '@herobids/llm';
import { runHybridEvaluator } from './hybrid-agent-evaluator.js';
import { createRuntimeCompositionState, type TechnicalScanState } from './runtime-composition.js';

vi.mock('@herobids/llm', () => ({
  callLlmProvider: vi.fn(),
}));

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
    expect(prompt).toContain('Available capital: $10000.00');
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
});