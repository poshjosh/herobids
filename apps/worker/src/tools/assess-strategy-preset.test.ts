import { describe, it, expect, vi } from 'vitest';
import type { ToolContext, AssessmentRequestPortOutcome } from '@herobids/domain';
import { assessStrategyPresetTool, mapOutcomeToResultEntry } from './assess-strategy-preset.js';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'test-agent',
    sessionId: 'session-1',
    phase: 'scout',
    redis: {
      hset: vi.fn(async () => 1),
      hget: vi.fn(async () => null),
      hgetall: vi.fn(async () => null),
      hdel: vi.fn(async () => 0),
      publish: vi.fn(async () => 0),
    },
    publishToInbound: vi.fn(async () => undefined),
    agentConfigOps: {
      getCurrentConfig: vi.fn().mockResolvedValue(null),
      persistConfig: vi.fn(),
      appendJournal: vi.fn(),
      notifyActorConfigUpdate: vi.fn(),
      getLlmTickCount: vi.fn().mockReturnValue(0),
    },
    ...overrides,
  };
}

function makeMockDb(selectResult: unknown[] = []) {
  const queryBuilder: Record<string, unknown> = {
    where: vi.fn().mockReturnValue({
      orderBy: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(selectResult),
      }),
    }),
  };

  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue(queryBuilder),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
  };
}

describe('assess_strategy_preset tool', () => {
  // ── Metadata ────────────────────────────────────────────────────────────

  it('has the correct tool name', () => {
    expect(assessStrategyPresetTool.name).toBe('assess_strategy_preset');
  });

  it('has the correct category', () => {
    expect(assessStrategyPresetTool.category).toBe('read-database');
  });

  it('has a parameters schema', () => {
    expect(assessStrategyPresetTool.parametersSchema).toBeDefined();
  });

  // ── Validation ──────────────────────────────────────────────────────────

  it('rejects empty symbols array', async () => {
    const ctx = makeCtx({ db: makeMockDb() });
    const result = await assessStrategyPresetTool.execute(
      { symbols: [], venueFamily: 'hyperliquid', instrumentKind: 'perp' },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('validation.invalid_params');
  });

  it('returns service unavailable when AssessmentRequestPort is not wired', async () => {
    const ctx = makeCtx({ db: undefined });
    const result = await assessStrategyPresetTool.execute(
      { symbols: ['BTC'], venueFamily: 'hyperliquid', instrumentKind: 'perp' },
      ctx,
    );
    // When port is not wired, the tool returns success with a service_unavailable result
    // for each instrument rather than failing at the DB level.
    expect(result.success).toBe(true);
    if (result.success && result.data) {
      expect(result.data.results[0]?.errorCode).toBe('assessment.service_unavailable');
    }
  });
});

// ── Helpers for mapOutcomeToResultEntry tests ────────────────────────────

const perpIdentity = {
  instrumentKind: 'perp' as const,
  venueFamily: 'hyperliquid',
  styleTier: 'standard' as const,
  symbol: 'BTC',
};

const swapIdentity = {
  instrumentKind: 'swap' as const,
  venueFamily: 'jupiter',
  styleTier: 'premium' as const,
  network: 'solana',
  address: '0xabc123',
};

const artifact = {
  assessedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-02T00:00:00.000Z',
  currentMarketSummary: 'Bullish momentum',
  regimeSummary: 'Strong uptrend',
  scanHealthSummary: 'All scans clear',
  presetRankings: [
    { presetKey: 'momentum', score: 85, grade: 'A' as const, strengths: ['Fast signals'], weaknesses: ['Noisy'] },
  ],
  recommendedPreset: 'momentum',
  confidence: 0.85,
  urgency: 'medium' as const,
};

describe('mapOutcomeToResultEntry', () => {
  // ── Success paths ──────────────────────────────────────────────────────

  it('populates canonicalIdentity, assessment, transitionReference and billing on cache_hit', () => {
    const result = mapOutcomeToResultEntry('BTC', {
      kind: 'cache_hit',
      requestId: 'req-1',
      assessmentArtifactId: 'art-1',
      canonicalIdentity: perpIdentity,
      artifact,
    }, 'key-1');

    expect(result.success).toBe(true);
    expect(result.symbol).toBe('BTC');
    expect(result.canonicalIdentity).toEqual(perpIdentity);
    expect(result.assessment).toBeDefined();
    expect(result.assessment!.artifactId).toBe('art-1');
    expect(result.assessment!.marketSummary).toBe('Bullish momentum');
    expect(result.assessment!.regimeSummary).toBe('Strong uptrend');
    expect(result.assessment!.scanHealthSummary).toBe('All scans clear');
    expect(result.assessment!.rankings).toHaveLength(1);
    expect(result.assessment!.rankings[0]!.presetKey).toBe('momentum');
    expect(result.assessment!.recommendedPreset).toBe('momentum');
    expect(result.assessment!.confidence).toBe(0.85);
    expect(result.assessment!.urgency).toBe('medium');
    expect(result.transitionReference?.assessmentArtifactId).toBe('art-1');
    expect(result.billing).toEqual({
      billed: true,
      requestId: 'req-1',
      idempotencyKey: 'key-1',
      source: 'cache_hit',
    });
    expect(result.error).toBeUndefined();
    expect(result.errorCode).toBeUndefined();
  });

  it('populates the same shape for assessment_completed with billing.source=new_run', () => {
    const result = mapOutcomeToResultEntry('ETH', {
      kind: 'assessment_completed',
      requestId: 'req-2',
      assessmentArtifactId: 'art-2',
      canonicalIdentity: { ...perpIdentity, symbol: 'ETH' },
      artifact: { ...artifact, recommendedPreset: 'mean-reversion' },
    }, 'key-2');

    expect(result.success).toBe(true);
    expect(result.symbol).toBe('ETH');
    expect(result.canonicalIdentity).toBeDefined();
    expect(result.assessment).toBeDefined();
    expect(result.assessment!.artifactId).toBe('art-2');
    expect(result.transitionReference?.assessmentArtifactId).toBe('art-2');
    expect(result.billing).toEqual({
      billed: true,
      requestId: 'req-2',
      idempotencyKey: 'key-2',
      source: 'new_run',
    });
  });

  it('produces identical shape for cache_hit and assessment_completed (only billing.source differs)', () => {
    const cacheHit = mapOutcomeToResultEntry('BTC', {
      kind: 'cache_hit',
      requestId: 'req-1',
      assessmentArtifactId: 'art-1',
      canonicalIdentity: perpIdentity,
      artifact,
    }, 'key-1');

    const completed = mapOutcomeToResultEntry('BTC', {
      kind: 'assessment_completed',
      requestId: 'req-1',
      assessmentArtifactId: 'art-1',
      canonicalIdentity: perpIdentity,
      artifact,
    }, 'key-1');

    // Same top-level shape
    expect(Object.keys(cacheHit).sort()).toEqual(Object.keys(completed).sort());
    // Same nested keys
    expect(Object.keys(cacheHit.assessment!).sort()).toEqual(Object.keys(completed.assessment!).sort());
    expect(Object.keys(cacheHit.billing!).sort()).toEqual(Object.keys(completed.billing!).sort());
    // Only billing.source differs
    expect(cacheHit.billing!.source).toBe('cache_hit');
    expect(completed.billing!.source).toBe('new_run');
    const { source: _s1, ...cacheBillingRest } = cacheHit.billing!;
    const { source: _s2, ...completedBillingRest } = completed.billing!;
    expect(cacheBillingRest).toEqual(completedBillingRest);
  });

  it('does not duplicate recommendation as top-level field', () => {
    const result = mapOutcomeToResultEntry('BTC', {
      kind: 'cache_hit',
      requestId: 'req-1',
      assessmentArtifactId: 'art-1',
      canonicalIdentity: perpIdentity,
      artifact,
    }, 'key-1');

    // recommendation appears only inside assessment, not at top level
    expect(result.assessment!.recommendedPreset).toBe('momentum');
    expect((result as Record<string, unknown>).recommendation).toBeUndefined();
    expect((result as Record<string, unknown>).recommendedPreset).toBeUndefined();
  });

  // ── Failure paths ──────────────────────────────────────────────────────

  it('includes canonicalIdentity on provider_failed when provided', () => {
    const result = mapOutcomeToResultEntry('BTC', {
      kind: 'provider_failed',
      requestId: 'req-3',
      error: 'LLM timeout',
      errorCode: 'provider.timeout',
      canonicalIdentity: perpIdentity,
    }, null);

    expect(result.success).toBe(false);
    expect(result.symbol).toBe('BTC');
    expect(result.error).toBe('LLM timeout');
    expect(result.errorCode).toBe('provider.timeout');
    expect(result.canonicalIdentity).toEqual(perpIdentity);
    expect(result.billing).toEqual({
      billed: false,
      requestId: 'req-3',
      idempotencyKey: null,
      source: 'failed',
    });
  });

  it('handles provider_failed without canonicalIdentity gracefully', () => {
    const result = mapOutcomeToResultEntry('BTC', {
      kind: 'provider_failed',
      requestId: 'req-4',
      error: 'Unknown error',
    }, 'key-4');

    expect(result.success).toBe(false);
    expect(result.canonicalIdentity).toBeUndefined();
    expect(result.error).toBe('Unknown error');
    expect(result.billing?.requestId).toBe('req-4');
  });

  it('includes canonicalIdentity on cooldown_blocked when provided', () => {
    const result = mapOutcomeToResultEntry('BTC', {
      kind: 'cooldown_blocked',
      nextEligibleAt: '2026-01-02T00:00:00.000Z',
      requestId: 'req-5',
      canonicalIdentity: perpIdentity,
    }, null);

    expect(result.success).toBe(false);
    expect(result.canonicalIdentity).toEqual(perpIdentity);
    expect(result.error).toContain('cooldown');
    expect(result.errorCode).toBe('assessment.cooldown_blocked');
  });

  it('handles billing_blocked with canonicalIdentity', () => {
    const result = mapOutcomeToResultEntry('BTC', {
      kind: 'billing_blocked',
      reason: 'Insufficient balance',
      requestId: 'req-6',
      canonicalIdentity: perpIdentity,
    }, 'key-6');

    expect(result.success).toBe(false);
    expect(result.canonicalIdentity).toEqual(perpIdentity);
    expect(result.errorCode).toBe('assessment.billing_blocked');
  });

  it('handles identity_unresolved without canonicalIdentity', () => {
    const result = mapOutcomeToResultEntry('BTC', {
      kind: 'identity_unresolved',
      reason: 'Unknown symbol',
      requestId: 'req-7',
    }, null);

    expect(result.success).toBe(false);
    expect(result.canonicalIdentity).toBeUndefined();
    expect(result.errorCode).toBe('assessment.identity_unresolved');
  });

  it('handles request_in_flight with canonicalIdentity', () => {
    const result = mapOutcomeToResultEntry('BTC', {
      kind: 'request_in_flight',
      message: 'Already pending',
      canonicalIdentity: perpIdentity,
    }, null);

    expect(result.success).toBe(false);
    expect(result.canonicalIdentity).toEqual(perpIdentity);
    expect(result.errorCode).toBe('assessment.request_in_flight');
  });

  // ── Identity roundtrip ─────────────────────────────────────────────────

  it('preserves swap instrumentKind identity with network and address', () => {
    const result = mapOutcomeToResultEntry('SOL-USDC', {
      kind: 'cache_hit',
      requestId: 'req-8',
      assessmentArtifactId: 'art-8',
      canonicalIdentity: swapIdentity,
      artifact,
    }, 'key-8');

    expect(result.success).toBe(true);
    expect(result.canonicalIdentity).toEqual(swapIdentity);
    expect(result.canonicalIdentity!.instrumentKind).toBe('swap');
    expect((result.canonicalIdentity as typeof swapIdentity).network).toBe('solana');
    expect((result.canonicalIdentity as typeof swapIdentity).address).toBe('0xabc123');
  });

  it('preserves dex instrumentKind identity with network and address', () => {
    const dexIdentity = { ...swapIdentity, instrumentKind: 'dex' as const };
    const result = mapOutcomeToResultEntry('SOL-USDC', {
      kind: 'assessment_completed',
      requestId: 'req-9',
      assessmentArtifactId: 'art-9',
      canonicalIdentity: dexIdentity,
      artifact,
    }, null);

    expect(result.success).toBe(true);
    expect(result.canonicalIdentity).toEqual(dexIdentity);
    expect(result.canonicalIdentity!.instrumentKind).toBe('dex');
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  it('handles null idempotencyKey correctly', () => {
    const result = mapOutcomeToResultEntry('BTC', {
      kind: 'cache_hit',
      requestId: 'req-10',
      assessmentArtifactId: 'art-10',
      canonicalIdentity: perpIdentity,
      artifact,
    }, null);

    expect(result.billing?.idempotencyKey).toBeNull();
  });

  it('handles null recommendedPreset in artifact', () => {
    const result = mapOutcomeToResultEntry('BTC', {
      kind: 'assessment_completed',
      requestId: 'req-11',
      assessmentArtifactId: 'art-11',
      canonicalIdentity: perpIdentity,
      artifact: { ...artifact, recommendedPreset: null },
    }, 'key-11');

    expect(result.assessment!.recommendedPreset).toBeNull();
  });

  it('uses default error message when provider_failed has no error string', () => {
    const result = mapOutcomeToResultEntry('BTC', {
      kind: 'provider_failed',
      requestId: 'req-12',
      // no error field provided
    }, null);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Provider failed');
    expect(result.errorCode).toBe('assessment.provider_failed');
  });
});
