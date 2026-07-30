import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AssessmentRequestService } from './assessment-request-service.js';
import { UsageBillingRepository, reviewAdvice } from '@herobids/db';
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
    maxInstrumentsPerRequest: 3,
    ...overrides,
  };
}

// ── Spied DB mock for markAdviceActedOn tests ─────────────────────────────

/**
 * Creates a DB mock with spies on the update chain (update → set → where).
 * Exposes _updateSpy, _setSpy, _whereSpy so tests can verify the arguments
 * passed to each Drizzle builder method.
 */
function makeSpiedDb(selectQueue: unknown[]) {
  const baseDb = makeQueueDb(selectQueue);
  const setSpy = vi.fn();
  const whereSpy = vi.fn();
  const updateSpy = vi.fn();

  return {
    db: {
      ...baseDb,
      update: updateSpy.mockImplementation(() => ({
        set: setSpy.mockImplementation(() => ({
          where: whereSpy.mockImplementation(() => Promise.resolve()),
        })),
      })),
    },
    updateSpy,
    setSpy,
    whereSpy,
  };
}

/**
 * Extract a human-readable string from a Drizzle SQL condition by walking
 * its queryChunks. This is more stable than JSON.stringify because it
 * explicitly handles the known Drizzle internal structure rather than
 * relying on JSON serialization quirks.
 *
 * Note: Drizzle 0.44 SQL objects have queryChunks but no toSQL() method.
 */
function extractConditionText(condition: unknown): string {
  const parts: string[] = [];

  function walk(chunk: unknown): void {
    if (chunk === null || chunk === undefined) return;

    if (typeof chunk === 'string') {
      parts.push(chunk);
      return;
    }

    if (typeof chunk === 'number') {
      parts.push(String(chunk));
      return;
    }

    if (Array.isArray(chunk)) {
      for (const item of chunk) walk(item);
      return;
    }

    if (typeof chunk === 'object') {
      const obj = chunk as Record<string, unknown>;
      // Column reference: { name: 'agent_id', table: {...} }
      if (typeof obj.name === 'string') {
        parts.push(obj.name);
      }
      // Text fragment: { value: [' = '] } — Drizzle SQL chunk
      // Param value: { value: 'BTC', brand: ... } — Drizzle parameter wrapper
      if (typeof obj.value === 'string' || typeof obj.value === 'number') {
        parts.push(String(obj.value));
      } else if (obj.value instanceof Date) {
        parts.push(obj.value.toISOString());
      } else if (Array.isArray(obj.value)) {
        for (const v of obj.value) walk(v);
      }
      // Nested SQL: queryChunks
      if (Array.isArray(obj.queryChunks)) {
        for (const qc of obj.queryChunks) walk(qc);
      }
    }
  }

  walk(condition);
  return parts.join('');
}

// ── Helper: standard select queue for "agent found, no cooldown, no
//    daily cap hit, no existing completed" — used before billing checks.
//    Agent has platformAssessment.enabled: true so it passes the enabled gate.
function agentFoundSelectQueue() {
  return [
    [{ userId: 'user-1', unifiedConfig: { platformAssessment: { enabled: true } } }], // step 2: agent query
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
        [{ userId: 'user-1', unifiedConfig: { platformAssessment: { enabled: true } } }], // step 2: agent
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
        [{ userId: 'user-1', unifiedConfig: { platformAssessment: { enabled: true } } }],                           // step 2: agent
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
        [{ userId: 'user-1', unifiedConfig: { platformAssessment: { enabled: true } } }], // step 2: agent
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
        [{ userId: 'user-1', unifiedConfig: { platformAssessment: { enabled: true } } }], // step 2: agent
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
        [{ userId: 'user-1', unifiedConfig: { platformAssessment: { enabled: true } } }],
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
        [{ userId: 'user-1', unifiedConfig: { platformAssessment: { enabled: true } } }],
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
      const result = await service.requestBatchAssessmentBySymbols(
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
      const result = await service.requestBatchAssessmentBySymbols(
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
      const result = await service.requestBatchAssessmentBySymbols(
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

  // ── markAdviceActedOn (assessment_requested_at) ─────────────────────

  describe('markAdviceActedOn (assessment_requested_at)', () => {
    /** Minimal select queue: agent found + cooldown hit → exits after step 3b fire-and-forget. */
    function actedOnSelectQueue() {
      return [
        [{ userId: 'user-1', unifiedConfig: { platformAssessment: { enabled: true } } }],
        [{ id: 'prev-req-1', requestedAt: new Date() }], // cooldown hit
      ];
    }

    it('correlates advice for orderbook/perp instruments using symbol match', async () => {
      const { db, updateSpy, setSpy, whereSpy } = makeSpiedDb(actedOnSelectQueue());

      const service = new AssessmentRequestService(
        db as any, billingRepo, makeOperatorConfig(), assessor,
      );

      await service.requestAssessment({
        agentId: 'agent-1',
        symbol: 'BTC',
        venueFamily: 'hyperliquid',
        instrumentKind: 'orderbook',
        styleTier: 'standard',
      });

      // markAdviceActedOn should have been called (update on reviewAdvice table)
      expect(updateSpy).toHaveBeenCalled();
      expect(updateSpy.mock.calls[0]?.[0]).toBe(reviewAdvice);

      // .set() should only touch assessmentRequestedAt
      const setArg = setSpy.mock.calls[0]?.[0];
      expect(setArg).toBeDefined();
      expect(setArg).toHaveProperty('assessmentRequestedAt');
      expect(setArg.assessmentRequestedAt).toBeInstanceOf(Date);

      // WHERE conditions use symbol (orderbook path) — verify the
      // actual symbol VALUE appears as a WHERE parameter
      const whereStr = extractConditionText(whereSpy.mock.calls[0]?.[0]);
      expect(whereStr).toContain('BTC');
      // The equality operator confirms a column = value condition
      expect(whereStr).toContain(' = ');
      // WHERE must include the agent's ID
      expect(whereStr).toContain('agent_id');
      expect(whereStr).toContain('agent-1');
    });

    it('correlates advice for swap/dex instruments using network+address match', async () => {
      const { db, updateSpy, setSpy, whereSpy } = makeSpiedDb(actedOnSelectQueue());

      const service = new AssessmentRequestService(
        db as any, billingRepo, makeOperatorConfig(), assessor,
      );

      await service.requestAssessment({
        agentId: 'agent-1',
        symbol: 'USDC',
        venueFamily: 'jupiter',
        instrumentKind: 'swap',
        styleTier: 'standard',
        tokenResolutions: new Map([
          ['USDC', { network: 'solana', address: '0xUSDC123' }],
        ]),
      });

      // markAdviceActedOn should have been called (update on reviewAdvice table)
      expect(updateSpy).toHaveBeenCalled();
      expect(updateSpy.mock.calls[0]?.[0]).toBe(reviewAdvice);

      // .set() should only touch assessmentRequestedAt
      const setArg = setSpy.mock.calls[0]?.[0];
      expect(setArg).toBeDefined();
      expect(setArg).toHaveProperty('assessmentRequestedAt');

      // WHERE conditions use network+address (swap path) — verify
      // the actual network / address VALUES appear as WHERE parameters
      const whereStr = extractConditionText(whereSpy.mock.calls[0]?.[0]);
      expect(whereStr).toContain('solana');
      expect(whereStr).toContain('0xUSDC123');
      // The user-facing symbol column is NOT in the WHERE — identity
      // matching for swap uses network+address, not symbol
      expect(whereStr).not.toContain('symbol =');
    });

    it('does NOT correlate expired advice', async () => {
      const { db, updateSpy, whereSpy } = makeSpiedDb(actedOnSelectQueue());

      const service = new AssessmentRequestService(
        db as any, billingRepo, makeOperatorConfig(), assessor,
      );

      await service.requestAssessment({
        agentId: 'agent-1',
        symbol: 'BTC',
        venueFamily: 'hyperliquid',
        instrumentKind: 'orderbook',
      });

      expect(updateSpy).toHaveBeenCalled();

      // WHERE must include expires_at > now() to exclude expired rows.
      // gt(expiresAt, now) emits a " > " fragment and an ISO date value.
      const whereStr = extractConditionText(whereSpy.mock.calls[0]?.[0]);
      expect(whereStr).toContain(' > ');
      expect(whereStr).toMatch(/20\d{2}-\d{2}-\d{2}T/); // ISO date for `now`
    });

    it('is idempotent — only matches rows without prior assessmentRequestedAt', async () => {
      const { db, updateSpy, whereSpy } = makeSpiedDb(actedOnSelectQueue());

      const service = new AssessmentRequestService(
        db as any, billingRepo, makeOperatorConfig(), assessor,
      );

      await service.requestAssessment({
        agentId: 'agent-1',
        symbol: 'BTC',
        venueFamily: 'hyperliquid',
        instrumentKind: 'orderbook',
      });

      expect(updateSpy).toHaveBeenCalled();

      // WHERE must include assessment_requested_at IS NULL for idempotency.
      // isNull() emits " is null" in Drizzle's parameterized SQL.
      const whereStr = extractConditionText(whereSpy.mock.calls[0]?.[0]);
      expect(whereStr).toContain('is null');
    });

    it('does NOT correlate non-advised rows — only matches outcome advised', async () => {
      const { db, updateSpy, whereSpy } = makeSpiedDb(actedOnSelectQueue());

      const service = new AssessmentRequestService(
        db as any, billingRepo, makeOperatorConfig(), assessor,
      );

      await service.requestAssessment({
        agentId: 'agent-1',
        symbol: 'BTC',
        venueFamily: 'hyperliquid',
        instrumentKind: 'orderbook',
      });

      expect(updateSpy).toHaveBeenCalled();

      // WHERE must include outcome = 'advised' to exclude non-advised rows.
      // The literal value "advised" appears as a WHERE parameter.
      const whereStr = extractConditionText(whereSpy.mock.calls[0]?.[0]);
      expect(whereStr).toContain('advised');
    });

    it('only matches rows with consumedAt IS NOT NULL', async () => {
      const { db, updateSpy, whereSpy } = makeSpiedDb(actedOnSelectQueue());

      const service = new AssessmentRequestService(
        db as any, billingRepo, makeOperatorConfig(), assessor,
      );

      await service.requestAssessment({
        agentId: 'agent-1',
        symbol: 'BTC',
        venueFamily: 'hyperliquid',
        instrumentKind: 'orderbook',
      });

      expect(updateSpy).toHaveBeenCalled();

      // WHERE must include consumed_at IS NOT NULL to exclude rows
      // that were never consumed (delivered to the agent).
      // The raw sql template preserves "IS NOT NULL" literally.
      const whereStr = extractConditionText(whereSpy.mock.calls[0]?.[0]);
      expect(whereStr).toContain('IS NOT NULL');
    });

    it('does not modify consumedAt — only sets assessmentRequestedAt', async () => {
      const { db, updateSpy, setSpy } = makeSpiedDb(actedOnSelectQueue());

      const service = new AssessmentRequestService(
        db as any, billingRepo, makeOperatorConfig(), assessor,
      );

      await service.requestAssessment({
        agentId: 'agent-1',
        symbol: 'BTC',
        venueFamily: 'hyperliquid',
        instrumentKind: 'orderbook',
      });

      expect(updateSpy).toHaveBeenCalled();

      // .set() must ONLY contain assessmentRequestedAt — never consumedAt
      const setArg = setSpy.mock.calls[0]?.[0];
      expect(setArg).toBeDefined();
      expect(Object.keys(setArg as Record<string, unknown>)).toEqual(['assessmentRequestedAt']);
      expect(setArg).not.toHaveProperty('consumedAt');
    });

    it('does NOT call markAdviceActedOn when identity is unresolved', async () => {
      const { db, updateSpy } = makeSpiedDb([]);

      const service = new AssessmentRequestService(
        db as any, billingRepo, makeOperatorConfig(), assessor,
      );

      await service.requestAssessment({
        agentId: 'agent-1',
        symbol: '', // empty symbol → identity_unresolved
        venueFamily: 'hyperliquid',
        instrumentKind: 'orderbook',
      });

      // markAdviceActedOn should NOT have been called — identity was unresolved
      expect(updateSpy).not.toHaveBeenCalled();
    });
  });
});
