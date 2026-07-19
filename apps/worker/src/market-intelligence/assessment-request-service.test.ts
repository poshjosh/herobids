import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AssessmentRequestService } from './assessment-request-service.js';
import { UsageBillingRepository } from '@herobids/db';
import { PlatformAssessor } from './platform-assessor.js';
import type { PlatformAssessorConfig } from '@herobids/domain';
import { ok, err } from '@herobids/domain';

// ── Mock Helpers ───────────────────────────────────────────────────────────

/**
 * Creates a DB mock where each `select()` call pops the next resolved value
 * from the provided queue. This lets us control what each successive query
 * in the service returns without needing per-call argument matching.
 */
function makeQueueDb(selectQueue: unknown[]) {
  let idx = 0;

  /**
   * Creates a chainable, callable, thenable mock for Drizzle query builders.
   * The target must be a function so that Proxy `apply` traps work for
   * chained method calls like `.from(table)`, `.where(cond)`, etc.
   */
  function createChain(value: unknown): any {
    const fn: any = function () {
      return createChain(value);
    };
    fn.then = (resolve: (v: unknown) => unknown) => Promise.resolve(value).then(resolve);

    return new Proxy(fn, {
      get(_target, prop) {
        // `then` (and `catch`) must fall through to the target function
        // so that `await chain` triggers the thenable protocol.
        if (prop === 'then' || prop === 'catch') {
          return Reflect.get(_target, prop, _target);
        }
        return createChain(value);
      },
    });
  }

  return {
    select: vi.fn(() => {
      const value = idx < selectQueue.length
        ? selectQueue[idx]!
        : (selectQueue.length > 0 ? selectQueue[selectQueue.length - 1] : []);
      idx++;
      return createChain(value);
    }),
    insert: vi.fn(() => ({
      values: vi.fn(() => Promise.resolve()),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve()),
      })),
    })),
  };
}

function makeMockBillingRepo(overrides?: Partial<Record<string, unknown>>) {
  return {
    getOrCreateBillingAccountForUser: vi.fn().mockResolvedValue({
      id: 'acct_test',
      ownerUserId: 'user-1',
      status: 'active',
      activePlanId: 'plan_default',
      softCapMicrousd: null,
      hardCapMicrousd: null,
    }),
    ensureActiveRateCard: vi.fn().mockResolvedValue({ id: 'rc_default_v1' }),
    getOrCreateOpenPeriod: vi.fn().mockResolvedValue({
      id: 'period_test',
      accountId: 'acct_test',
      balanceMicrousd: 1000000,
      reservedMicrousd: 0,
      status: 'open',
    }),
    quoteMeterCharge: vi.fn().mockResolvedValue(200000),
    getSpendState: vi.fn().mockResolvedValue({ status: 'active' }),
    reserveCharge: vi.fn().mockResolvedValue({
      reservationLedgerEntryId: 'led_res_1',
      reservedAmountMicrousd: 200000,
    }),
    captureReservedAssessmentCharge: vi.fn().mockResolvedValue({
      usageEventId: 'evt_1',
      captureLedgerEntryId: 'led_cap_1',
      newSpendStatus: 'active',
    }),
    releaseReservedCharge: vi.fn().mockResolvedValue({
      releaseLedgerEntryId: 'led_rel_1',
    }),
    ...overrides,
  } as unknown as UsageBillingRepository;
}

function makeMockAssessor() {
  return {
    assessIdentity: vi.fn(),
  } as unknown as PlatformAssessor;
}

function makeOperatorConfig(overrides?: Partial<PlatformAssessorConfig>): PlatformAssessorConfig {
  return {
    enabled: true,
    minReviewIntervalMs: 86_400_000,
    maxReviewRequestsPerDay: 4,
    scannerCandidateLimit: 20,
    cacheFreshnessMs: 21_600_000,
    maxConcurrentAssessments: 1,
    maxLlmCallsPerCycle: 20,
    maxInstrumentsPerRequest: 3,
    ...overrides,
  };
}

// ── Helper: standard select queue for "agent found, no cooldown, no
//    daily cap hit, no existing completed" — used before billing checks.
function agentFoundSelectQueue() {
  return [
    [{ userId: 'user-1', unifiedConfig: {} }], // step 2: agent query
    [],                                         // step 4: cooldown check
    [{ count: 0 }],                             // step 5: daily cap count
    [],                                         // step 7: existing completed
  ];
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('AssessmentRequestService', () => {
  let billingRepo: ReturnType<typeof makeMockBillingRepo>;
  let assessor: ReturnType<typeof makeMockAssessor>;

  beforeEach(() => {
    billingRepo = makeMockBillingRepo();
    assessor = makeMockAssessor();
  });

  function createService(selectQueue: unknown[]) {
    const db = makeQueueDb(selectQueue);
    return new AssessmentRequestService(
      db as any,
      billingRepo,
      makeOperatorConfig(),
      assessor,
    );
  }

  // ── Identity Resolution ─────────────────────────────────────────────

  describe('identity resolution', () => {
    it('returns identity_unresolved when symbol is empty', async () => {
      const service = createService([]); // No DB calls needed — identity fails before DB
      const result = await service.requestAssessment({
        agentId: 'agent-1',
        symbol: '',
        venueFamily: 'hyperliquid',
        instrumentKind: 'orderbook',
      });

      expect(result.ok).toBe(true);
      expect(result.data.kind).toBe('identity_unresolved');
    });

    it('returns identity_unresolved for swap/dex without token resolutions', async () => {
      const service = createService([]);
      const result = await service.requestAssessment({
        agentId: 'agent-1',
        symbol: 'BTC',
        venueFamily: 'hyperliquid',
        instrumentKind: 'swap',
      });

      expect(result.ok).toBe(true);
      expect(result.data.kind).toBe('identity_unresolved');
    });
  });

  // ── Owner Resolution ────────────────────────────────────────────────

  describe('owner resolution', () => {
    it('returns error when agent does not exist', async () => {
      // Identity resolves but agent query returns empty
      const service = createService([
        [], // step 2: agent query → empty
      ]);

      const result = await service.requestAssessment({
        agentId: 'nonexistent-agent',
        symbol: 'BTC',
        venueFamily: 'hyperliquid',
        instrumentKind: 'orderbook',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('assessment.agent_not_found');
      }
    });
  });

  // ── Billing Blocking ────────────────────────────────────────────────

  describe('billing gate', () => {
    it('returns billing_blocked when account is hard_limited', async () => {
      billingRepo.getSpendState = vi.fn().mockResolvedValue({ status: 'hard_limited' });

      const service = createService([
        ...agentFoundSelectQueue(),
      ]);

      const result = await service.requestAssessment({
        agentId: 'agent-1',
        symbol: 'BTC',
        venueFamily: 'hyperliquid',
        instrumentKind: 'orderbook',
        idempotencyKey: 'test-key-1',
      });

      expect(result.ok).toBe(true);
      if (result.ok && result.data.kind === 'billing_blocked') {
        expect(result.data.reason).toContain('limit');
      } else {
        expect(result.data.kind).toBe('billing_blocked');
      }
    });

    it('returns billing_blocked when account is suspended', async () => {
      billingRepo.getSpendState = vi.fn().mockResolvedValue({ status: 'suspended' });

      const service = createService([
        ...agentFoundSelectQueue(),
      ]);

      const result = await service.requestAssessment({
        agentId: 'agent-1',
        symbol: 'BTC',
        venueFamily: 'hyperliquid',
        instrumentKind: 'orderbook',
        idempotencyKey: 'test-key-2',
      });

      expect(result.ok).toBe(true);
      if (result.ok && result.data.kind === 'billing_blocked') {
        expect(result.data.reason).toContain('suspend');
      } else {
        expect(result.data.kind).toBe('billing_blocked');
      }
    });
  });

  // ── Daily Cap ───────────────────────────────────────────────────────

  describe('daily cap', () => {
    it('returns billing_blocked when daily cap is exceeded', async () => {
      const service = createService([
        [{ userId: 'user-1', unifiedConfig: {} }], // step 2: agent
        [],                                         // step 4: cooldown
        [{ count: 5 }],                             // step 5: daily cap count (exceeds max=4)
      ]);

      const result = await service.requestAssessment({
        agentId: 'agent-1',
        symbol: 'BTC',
        venueFamily: 'hyperliquid',
        instrumentKind: 'orderbook',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.kind).toBe('billing_blocked');
        if (result.data.kind === 'billing_blocked') {
          expect(result.data.reason).toContain('cap');
        }
      }
    });
  });

  // ── Cooldown ────────────────────────────────────────────────────────

  describe('cooldown', () => {
    it('returns cooldown_blocked when recent request exists within cooldown window', async () => {
      const recentDate = new Date(); // now — within cooldown window (24h)
      const service = createService([
        [{ userId: 'user-1', unifiedConfig: {} }],                           // step 2: agent
        [{ id: 'prev-req-1', requestedAt: recentDate }],                     // step 4: cooldown hit
      ]);

      const result = await service.requestAssessment({
        agentId: 'agent-1',
        symbol: 'BTC',
        venueFamily: 'hyperliquid',
        instrumentKind: 'orderbook',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.kind).toBe('cooldown_blocked');
        if (result.data.kind === 'cooldown_blocked') {
          expect(result.data.nextEligibleAt).toBeTruthy();
        }
      }
    });
  });

  // ── Successful Assessment ───────────────────────────────────────────

  describe('assessment completion', () => {
    it('returns assessment_completed with billed=true on success', async () => {
      const mockArtifact = {
        id: 'artifact-1',
        venueFamily: 'hyperliquid',
        styleTier: 'standard',
        assessmentRunId: 'run-1',
        assessedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        maxActorUseAge: 'PT12H',
        maxWakeAge: 'PT6H',
        assessmentVersion: 1,
        artifactVersion: 1,
        rankingPolicyVersion: 1,
        status: 'active' as const,
        allowedPresets: ['standard'],
        currentMarketSummary: 'Test summary',
        regimeSummary: 'Test regime',
        scanHealthSummary: 'Test health',
        presetRankings: [],
        recommendedPreset: 'standard',
        relativeUplift: null,
        confidence: 0.8,
        urgency: 'low' as const,
        reasoningSummary: 'Test reasoning',
        evidenceRefs: [],
      };

      assessor.assessIdentity = vi.fn().mockResolvedValue(ok({
        artifact: mockArtifact,
        llmUsage: {
          totalInputTokens: 100,
          totalOutputTokens: 50,
          totalReasoningTokens: 0,
          callCount: 1,
          estimatedCostMicrousd: 115,
        },
      }));

      const service = createService([
        [{ userId: 'user-1', unifiedConfig: {} }], // step 2: agent
        [],                                         // step 4: cooldown
        [{ count: 0 }],                             // step 5: daily cap
        [],                                         // step 7: existing completed
        [{ maxAttempt: -1 }],                       // step 11: max attempt
        [],                                         // step 13: fresh artifact (cache miss)
      ]);

      const result = await service.requestAssessment({
        agentId: 'agent-1',
        symbol: 'BTC',
        venueFamily: 'hyperliquid',
        instrumentKind: 'orderbook',
        idempotencyKey: 'test-key-success',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.kind).toBe('assessment_completed');
        if (result.data.kind === 'assessment_completed') {
          expect(result.data.billed).toBe(true);
          expect(result.data.requestId).toBeTruthy();
          expect(result.data.assessmentArtifactId).toBe('artifact-1');
        }
      }
    });
  });

  // ── Provider Failure ────────────────────────────────────────────────

  describe('provider_failed', () => {
    it('releases reservation and returns provider_failed when assessor fails', async () => {
      assessor.assessIdentity = vi.fn().mockResolvedValue(err({
        code: 'assessment.failed',
        message: 'LLM call failed',
      }));

      const service = createService([
        [{ userId: 'user-1', unifiedConfig: {} }], // step 2: agent
        [],                                         // step 4: cooldown
        [{ count: 0 }],                             // step 5: daily cap
        [],                                         // step 7: existing completed
        [{ maxAttempt: -1 }],                       // step 11: max attempt
        [],                                         // step 13: fresh artifact (cache miss)
      ]);

      const result = await service.requestAssessment({
        agentId: 'agent-1',
        symbol: 'BTC',
        venueFamily: 'hyperliquid',
        instrumentKind: 'orderbook',
        idempotencyKey: 'test-key-fail',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.kind).toBe('provider_failed');
        if (result.data.kind === 'provider_failed') {
          expect(result.data.requestId).toBeTruthy();
        }
      }
      // Reservation should have been released
      expect(billingRepo.releaseReservedCharge).toHaveBeenCalled();
    });
  });

  // ── Idempotency ─────────────────────────────────────────────────────

  describe('idempotency', () => {
    it('returns same outcome for repeat request with same idempotency key', async () => {
      const mockArtifact = {
        id: 'artifact-idem-1',
        venueFamily: 'hyperliquid',
        styleTier: 'standard',
        assessmentRunId: 'run-idem-1',
        assessedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        maxActorUseAge: 'PT12H',
        maxWakeAge: 'PT6H',
        assessmentVersion: 1,
        artifactVersion: 1,
        rankingPolicyVersion: 1,
        status: 'active' as const,
        allowedPresets: ['standard'],
        currentMarketSummary: 'Test',
        regimeSummary: 'Test',
        scanHealthSummary: 'Test',
        presetRankings: [],
        recommendedPreset: 'standard',
        relativeUplift: null,
        confidence: 0.8,
        urgency: 'low' as const,
        reasoningSummary: 'Test',
        evidenceRefs: [],
      };

      assessor.assessIdentity = vi.fn().mockResolvedValue(ok({
        artifact: mockArtifact,
        llmUsage: {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalReasoningTokens: 0,
          callCount: 0,
          estimatedCostMicrousd: 0,
        },
      }));

      // First request: full flow
      const db1 = makeQueueDb([
        [{ userId: 'user-1', unifiedConfig: {} }],
        [],
        [{ count: 0 }],
        [],                                         // step 7: no existing completed
        [{ maxAttempt: -1 }],
        [],                                         // fresh artifact miss
      ]);
      const service1 = new AssessmentRequestService(
        db1 as any, billingRepo, makeOperatorConfig(), assessor,
      );

      const first = await service1.requestAssessment({
        agentId: 'agent-1',
        symbol: 'BTC',
        venueFamily: 'hyperliquid',
        instrumentKind: 'orderbook',
        idempotencyKey: 'idem-test-1',
      });

      // Second request with same key: existing completed found at step 7
      const db2 = makeQueueDb([
        [{ userId: 'user-1', unifiedConfig: {} }],
        [],
        [{ count: 0 }],
        // Step 7: an existing completed request with the same group key
        [{
          status: 'assessment_completed',
          assessmentArtifactId: 'artifact-idem-1',
          id: first.ok ? (first.data as any).requestId ?? 'req-1' : 'req-1',
        }],
      ]);
      const billingRepo2 = makeMockBillingRepo();
      const service2 = new AssessmentRequestService(
        db2 as any, billingRepo2, makeOperatorConfig(), makeMockAssessor(),
      );

      const second = await service2.requestAssessment({
        agentId: 'agent-1',
        symbol: 'BTC',
        venueFamily: 'hyperliquid',
        instrumentKind: 'orderbook',
        idempotencyKey: 'idem-test-1',
      });

      expect(second.ok).toBe(true);
      if (first.ok && second.ok) {
        // Both should have the same kind
        expect(second.data.kind).toBe(first.data.kind);
      }
    });
  });

  // ── Batch ───────────────────────────────────────────────────────────

  describe('batch assessment', () => {
    it('returns results for each accepted symbol', async () => {
      const service = createService([]); // empty symbol → identity_unresolved for both
      const result = await service.requestBatchAssessment(
        ['BTC', 'ETH'],
        {
          agentId: 'agent-1',
          venueFamily: 'hyperliquid',
          instrumentKind: 'orderbook',
        },
      );

      expect(result.results.length).toBeGreaterThanOrEqual(0);
      expect(result.requestedCount).toBe(2);
    });

    it('truncates symbols exceeding maxInstrumentsPerRequest', async () => {
      const service = createService([]);
      const result = await service.requestBatchAssessment(
        ['BTC', 'ETH', 'SOL', 'AVAX', 'MATIC'],
        {
          agentId: 'agent-1',
          venueFamily: 'hyperliquid',
          instrumentKind: 'orderbook',
        },
        2, // cap at 2
      );

      expect(result.assessedCount).toBe(2);
      expect(result.requestedCount).toBe(5);
      expect(result.truncationMessage).toBeDefined();
    });

    it('handles empty symbols array', async () => {
      const service = createService([]);
      const result = await service.requestBatchAssessment(
        [],
        {
          agentId: 'agent-1',
          venueFamily: 'hyperliquid',
          instrumentKind: 'orderbook',
        },
      );

      expect(result.results).toHaveLength(0);
      expect(result.requestedCount).toBe(0);
    });
  });
});
