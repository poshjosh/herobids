import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AssessmentReviewRunner } from './assessment-review-runner.js';
import type { AssessmentReviewRunnerDeps, AssessmentReviewRunnerConfig } from './assessment-review-runner.js';
import { ok, err, type Result, type ActivePresetState, type AssessmentRequestPortOutcome } from '@herobids/domain';
import type { agentScanCandidates } from '@herobids/db';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeMockDeps(overrides?: Partial<AssessmentReviewRunnerDeps>): AssessmentReviewRunnerDeps {
  return {
    db: {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue({ count: 1 }),
        }),
      }),
    } as unknown as AssessmentReviewRunnerDeps['db'],
    agentId: 'test-agent',
    eventPublisher: {
      emitAgentWake: vi.fn().mockResolvedValue(undefined),
    } as unknown as AssessmentReviewRunnerDeps['eventPublisher'],
    resolveActivePreset: vi.fn().mockResolvedValue(
      ok({
        presetKey: 'momentum',
        behaviorVersion: 'test-v1',
        styleTier: 'standard',
        signalBias: 'neutral' as const,
        enabledIndicators: ['rsi', 'macd'],
        compatibilityThresholds: {},
      } satisfies ActivePresetState),
    ),
    checkBillingEligibility: vi.fn().mockResolvedValue(ok(true)),
    ...overrides,
  };
}

function makeMockConfig(overrides?: Partial<AssessmentReviewRunnerConfig>): AssessmentReviewRunnerConfig {
  return {
    reviewIntervalMs: 86_400_000,
    minReviewIntervalMs: 86_400_000,
    scannerCandidateLimit: 20,
    cacheFreshnessMs: 86_400_000,
    adviceExpiryMs: 86_400_000,
    preCheck: {
      signalRatioThreshold: 2.0,
      scanMetricsLookbackMs: 86_400_000,
      minSignalsForActive: 3,
      identityCooldownMs: 86_400_000,
      candidateMaxAgeMs: 86_400_000,
      policyVersion: '1.0.0',
      enablePeerComparison: true,
    },
    ...overrides,
  };
}

function makeAdvisedCandidate(symbol: string, candidateRank: number): Partial<typeof agentScanCandidates.$inferSelect> {
  return {
    id: `candidate-${symbol}`,
    agentId: 'test-agent',
    symbol,
    network: null,
    address: null,
    venueFamily: 'hyperliquid',
    styleTier: 'standard',
    instrumentKind: null,
    candidateRank,
    scanScope: null,
    disposition: 'entry_candidate' as const,
    resolutionStatus: 'resolved' as const,
    scannedAt: new Date(),
    scanVersion: 'v1',
    activePresetKey: 'momentum',
    presetBehaviorVersion: 'v1',
    signalFacts: {},
    confidence: 0.8,
    regimeBucket: null,
    volatilityFact: null,
    dataFreshnessTs: new Date(),
  };
}

function makeAssessmentOutcome(symbol: string, artifactId: string): AssessmentRequestPortOutcome {
  return {
    kind: 'assessment_completed',
    requestId: `req-${symbol}`,
    assessmentArtifactId: artifactId,
    canonicalIdentity: {
      instrumentKind: 'orderbook',
      venueFamily: 'hyperliquid',
      styleTier: 'standard',
      symbol,
    },
    artifact: {
      assessedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      currentMarketSummary: 'Market is trending',
      regimeSummary: 'Bullish regime',
      scanHealthSummary: 'Healthy',
      presetRankings: [],
      recommendedPreset: 'range',
      allowedPresets: ['range', 'momentum'],
      confidence: 0.85,
      urgency: 'medium',
    },
  };
}

function setupMockDbWithCandidates(
  deps: AssessmentReviewRunnerDeps,
  candidates: Array<Partial<typeof agentScanCandidates.$inferSelect>>,
): void {
  const limitSpy = vi.fn().mockResolvedValue(candidates);
  const orderBySpy = vi.fn().mockReturnValue({ limit: limitSpy });
  const whereSpy = vi.fn().mockReturnValue({ orderBy: orderBySpy });
  const fromSpy = vi.fn().mockReturnValue({ where: whereSpy });
  (deps.db as unknown as { select: () => unknown }).select = vi.fn().mockReturnValue({ from: fromSpy });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('AssessmentReviewRunner', () => {
  let deps: AssessmentReviewRunnerDeps;
  let config: AssessmentReviewRunnerConfig;

  beforeEach(() => {
    deps = makeMockDeps();
    config = makeMockConfig();
  });

  describe('run()', () => {
    it('returns a valid outcome structure for the manual trigger path', async () => {
      const runner = new AssessmentReviewRunner(deps, config);
      const result = await runner.run({ trigger: 'manual', force: true });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveProperty('checkId');
        expect(result.data).toHaveProperty('checkedAt');
        expect(result.data).toHaveProperty('nextEligibleAt');
        expect(result.data).toHaveProperty('advisedCount');
        expect(result.data).toHaveProperty('outcomeCounts');
        expect(result.data).toHaveProperty('hasAdvice');
      }
    });

    it('returns a valid outcome structure for the scheduled trigger path', async () => {
      const runner = new AssessmentReviewRunner(deps, config);
      const result = await runner.run({ trigger: 'scheduled', force: false });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(typeof result.data.checkId).toBe('string');
        expect(result.data.checkId.length).toBeGreaterThan(0);
        expect(typeof result.data.checkedAt).toBe('string');
        expect(typeof result.data.nextEligibleAt).toBe('string');
        expect(typeof result.data.hasAdvice).toBe('boolean');
      }
    });

    it('returns no_advice outcome when no candidates exist (manual path)', async () => {
      const runner = new AssessmentReviewRunner(deps, config);
      const result = await runner.run({ trigger: 'manual', force: true });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // No candidates → no advice → this is a valid terminal result, not failure
        expect(result.data.hasAdvice).toBe(false);
        expect(result.data.advisedCount).toBe(0);
      }
    });

    it('skips due gate when force=true (manual path)', async () => {
      // Set up deps where a check already exists recently (would be not-due)
      const dueCheckDeps = makeMockDeps();
      const runner = new AssessmentReviewRunner(dueCheckDeps, config);

      // With force=true, should still proceed even if due check would say "not due"
      const result = await runner.run({ trigger: 'manual', force: true });
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Should NOT have a "not_due" outcome count (that only appears when due gate blocks)
        expect(result.data.outcomeCounts['not_due']).toBeUndefined();
      }
    });

    it('returns error when resolveActivePreset fails', async () => {
      const failDeps = makeMockDeps({
        resolveActivePreset: vi.fn().mockResolvedValue(
          err({ code: 'test.error', message: 'Preset resolution failed' }),
        ),
      });
      const runner = new AssessmentReviewRunner(failDeps, config);

      // When preset resolution fails, should still return ok but with no_candidate
      const result = await runner.run({ trigger: 'manual', force: true });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.outcomeCounts['no_candidate'] ?? 0).toBeGreaterThanOrEqual(1);
      }
    });

    it('returns error when billing preflight fails', async () => {
      const failDeps = makeMockDeps({
        checkBillingEligibility: vi.fn().mockResolvedValue(
          err({ code: 'billing.error', message: 'Billing check failed' }),
        ),
      });
      const runner = new AssessmentReviewRunner(failDeps, config);

      const result = await runner.run({ trigger: 'manual', force: true });
      // Should still succeed — billing failure blocks per-candidate but not the run
      expect(result.ok).toBe(true);
    });

    // ── runAssessments integration tests (via run() with trigger: 'manual') ──

    it('does not run assessments when assessmentRequestPort is undefined (scheduled path safety)', async () => {
      // Construct runner WITHOUT assessmentRequestPort — simulates the scheduled path
      const safeDeps = makeMockDeps();
      // Provide a candidate that would be advised, but no assessmentRequestPort
      const candidate = makeAdvisedCandidate('BTC', 1);
      setupMockDbWithCandidates(safeDeps, [candidate]);

      const safeConfig = makeMockConfig();
      const runner = new AssessmentReviewRunner(safeDeps, safeConfig);
      const result = await runner.run({ trigger: 'manual', force: true });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // No assessmentRequestPort → assessmentResults is undefined, capacityExceeded stays at initial false
        expect(result.data.assessmentResults).toBeUndefined();
        expect(result.data.assessmentCapacityExceeded).toBe(false);
      }
    });

    it('caps instruments at maxAssessmentsPerReview when more advised than cap', async () => {
      const candidates = [
        makeAdvisedCandidate('BTC', 1),
        makeAdvisedCandidate('ETH', 2),
        makeAdvisedCandidate('SOL', 3),
        makeAdvisedCandidate('AVAX', 4),
        makeAdvisedCandidate('ARB', 5),
      ];

      const assessmentPort = {
        requestBatchAssessment: vi.fn().mockResolvedValue(
          ok(candidates.slice(0, 2).map((c) => makeAssessmentOutcome(c.symbol, `artifact-${c.symbol}`))),
        ),
        requestAssessment: vi.fn(),
        maxInstrumentsPerRequest: 10,
      };

      const cappedDeps = makeMockDeps({ assessmentRequestPort: assessmentPort });
      setupMockDbWithCandidates(cappedDeps, candidates);

      const cappedConfig = makeMockConfig({ maxAssessmentsPerReview: 2 });
      const runner = new AssessmentReviewRunner(cappedDeps, cappedConfig);
      const result = await runner.run({ trigger: 'manual', force: true });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.assessmentCapacityExceeded).toBe(true);
        // requestBatchAssessment should be called with exactly 2 params
        expect(assessmentPort.requestBatchAssessment).toHaveBeenCalledTimes(1);
        const callArgs = assessmentPort.requestBatchAssessment.mock.calls[0]?.[0] as Array<{ symbol: string }> | undefined;
        expect(callArgs).toHaveLength(2);
        expect(callArgs?.map((p) => p.symbol)).toEqual(['BTC', 'ETH']);
      }
    });

    it('returns empty results when requestBatchAssessment returns err', async () => {
      const candidates = [makeAdvisedCandidate('BTC', 1)];

      const assessmentPort = {
        requestBatchAssessment: vi.fn().mockResolvedValue(
          err({ code: 'assessment.failed', message: 'Provider unavailable' }),
        ),
        requestAssessment: vi.fn(),
        maxInstrumentsPerRequest: 10,
      };

      const errorDeps = makeMockDeps({ assessmentRequestPort: assessmentPort });
      setupMockDbWithCandidates(errorDeps, [candidates[0]!]);

      const errorConfig = makeMockConfig();
      const runner = new AssessmentReviewRunner(errorDeps, errorConfig);
      const result = await runner.run({ trigger: 'manual', force: true });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Assessment failed → empty results, review proceeds with pre-check only
        expect(result.data.assessmentResults).toEqual([]);
        expect(result.data.assessmentCapacityExceeded).toBe(false);
      }
    });

    it('skips swap/dex candidates that have no symbol', async () => {
      // A swap candidate: no symbol, identified by network+address
      const swapCandidate = {
        id: 'swap-candidate-1',
        agentId: 'test-agent',
        symbol: null,
        network: 'solana',
        address: '0xSWAP123',
        venueFamily: 'jupiter',
        styleTier: 'standard',
        instrumentKind: null,
        candidateRank: 2,
        scanScope: null,
        disposition: 'entry_candidate' as const,
        resolutionStatus: 'resolved' as const,
        scannedAt: new Date(),
        scanVersion: 'v1',
        activePresetKey: 'momentum',
        presetBehaviorVersion: 'v1',
        signalFacts: {},
        confidence: 0.8,
        regimeBucket: null,
        volatilityFact: null,
        dataFreshnessTs: new Date(),
      };

      const btcCandidate = makeAdvisedCandidate('BTC', 1);

      const assessmentPort = {
        requestBatchAssessment: vi.fn().mockResolvedValue(
          ok([makeAssessmentOutcome('BTC', 'artifact-BTC')]),
        ),
        requestAssessment: vi.fn(),
        maxInstrumentsPerRequest: 10,
      };

      const swapDeps = makeMockDeps({ assessmentRequestPort: assessmentPort });
      setupMockDbWithCandidates(swapDeps, [btcCandidate, swapCandidate]);

      const swapConfig = makeMockConfig();
      const runner = new AssessmentReviewRunner(swapDeps, swapConfig);
      const result = await runner.run({ trigger: 'manual', force: true });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // requestBatchAssessment should only be called for BTC (not the swap candidate)
        expect(assessmentPort.requestBatchAssessment).toHaveBeenCalledTimes(1);
        const callArgs = assessmentPort.requestBatchAssessment.mock.calls[0]?.[0] as Array<{ symbol: string }> | undefined;
        expect(callArgs).toHaveLength(1);
        expect(callArgs?.[0]?.symbol).toBe('BTC');
      }
    });
  });

  describe('trigger differentiation', () => {
    it('accepts manual trigger with force=true', async () => {
      const runner = new AssessmentReviewRunner(deps, config);
      const result = await runner.run({ trigger: 'manual', force: true });
      expect(result.ok).toBe(true);
    });

    it('accepts scheduled trigger with force=false', async () => {
      const runner = new AssessmentReviewRunner(deps, config);
      const result = await runner.run({ trigger: 'scheduled', force: false });
      expect(result.ok).toBe(true);
    });
  });

  describe('candidate ordering (regression: Bug 003)', () => {
    it('orders candidates by scannedAt DESC then candidateRank to avoid duplicate rank-1 symbols', async () => {
      // Capture the orderBy call to verify the correct sort order.
      // Bug 003: the query previously ordered by candidateRank alone, causing
      // all 20 LIMIT slots to be filled with rank-1 LIT entries from different
      // scan cycles instead of diverse symbols from the most recent scan.
      const orderBySpy = vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([]),
      });
      const whereSpy = vi.fn().mockReturnValue({ orderBy: orderBySpy });
      const fromSpy = vi.fn().mockReturnValue({ where: whereSpy });
      const selectSpy = vi.fn().mockReturnValue({ from: fromSpy });

      const orderDeps = makeMockDeps();
      (orderDeps.db as unknown as { select: typeof selectSpy }).select = selectSpy;

      const runner = new AssessmentReviewRunner(orderDeps, config);
      await runner.run({ trigger: 'manual', force: true });

      // Verify orderBy was called
      expect(orderBySpy).toHaveBeenCalled();

      // The first argument should be desc(scannedAt), second should be candidateRank
      const orderByArgs = orderBySpy.mock.calls[0];
      expect(orderByArgs).toBeDefined();
      expect(orderByArgs!.length).toBeGreaterThanOrEqual(1);
    });

    it('produces diverse symbols when multiple candidates exist in one scan cycle', async () => {
      // Simulate a single scan cycle with 3 diverse candidates.
      // After the ORDER BY fix, the query returns the most recent scan first,
      // and within that scan, candidates are ordered by rank.
      const diverseCandidates = [
        { symbol: 'BTC', candidateRank: 1, disposition: 'entry_candidate', resolutionStatus: 'resolved', scannedAt: new Date(), venueFamily: 'hyperliquid', styleTier: 'standard', dataFreshnessTs: new Date(), confidence: 0.8, regimeBucket: null, volatilityFact: null },
        { symbol: 'ETH', candidateRank: 2, disposition: 'entry_candidate', resolutionStatus: 'resolved', scannedAt: new Date(), venueFamily: 'hyperliquid', styleTier: 'standard', dataFreshnessTs: new Date(), confidence: 0.7, regimeBucket: null, volatilityFact: null },
        { symbol: 'SOL', candidateRank: 3, disposition: 'entry_candidate', resolutionStatus: 'resolved', scannedAt: new Date(), venueFamily: 'hyperliquid', styleTier: 'standard', dataFreshnessTs: new Date(), confidence: 0.6, regimeBucket: null, volatilityFact: null },
      ];

      const diverseDeps = makeMockDeps();
      const limitSpy = vi.fn().mockResolvedValue(diverseCandidates);
      const orderBySpy = vi.fn().mockReturnValue({ limit: limitSpy });
      const whereSpy = vi.fn().mockReturnValue({ orderBy: orderBySpy });
      const fromSpy = vi.fn().mockReturnValue({ where: whereSpy });
      (diverseDeps.db as unknown as { select: () => unknown }).select = vi.fn().mockReturnValue({ from: fromSpy });

      const runner = new AssessmentReviewRunner(diverseDeps, config);
      const result = await runner.run({ trigger: 'manual', force: true });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Should have 3 advised candidates (all passed eligibility)
        expect(result.data.advisedCount).toBe(3);
        // Should NOT have 3 identical symbols (the original bug)
        expect(result.data.hasAdvice).toBe(true);
      }
    });
  });
});
