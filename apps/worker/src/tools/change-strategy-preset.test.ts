import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext, PresetTransitionPort, PresetTransitionApplicationResult } from '@herobids/domain';
import { ok } from '@herobids/domain';
import { marketAssessmentArtifacts } from '@herobids/db';
import { changeStrategyPresetTool, setPresetTransitionPort, clearPresetTransitionPort } from './change-strategy-preset.js';

function makeMockTransitionPort(overrides?: Partial<PresetTransitionPort>): PresetTransitionPort {
  return {
    applyTransition: vi.fn().mockResolvedValue(ok<PresetTransitionApplicationResult>({
      transitionId: 'transition-1',
      state: 'applied',
      positionActionResults: null,
      appliedAt: new Date().toISOString(),
    })),
    recommendTransition: vi.fn(),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    phase: 'judge',
    redis: {
      hset: vi.fn(async () => 1),
      hget: vi.fn(async () => null),
      hgetall: vi.fn(async () => null),
      hdel: vi.fn(async () => 0),
      publish: vi.fn(async () => 0),
    },
    publishToInbound: vi.fn(async () => undefined),
    agentConfigOps: {
      getCurrentConfig: vi.fn().mockResolvedValue({ platformAssessment: { enabled: true } }),
      persistConfig: vi.fn(),
      appendJournal: vi.fn(),
      notifyActorConfigUpdate: vi.fn(),
      getLlmTickCount: vi.fn().mockReturnValue(0),
    },
    db: makeMockDb(),
    ...overrides,
  };
}

function makeMockDb(overrides?: {
  selectResult?: unknown[];
  insertFn?: () => Promise<unknown>;
}) {
  const selectResult = overrides?.selectResult ?? [];
  const insertFn = overrides?.insertFn ?? (async () => undefined);

  // Build a mock that supports the drizzle query chain:
  // db.select().from(table).where(...).limit(1) and
  // db.select().from(table).where(...).orderBy(...).limit(1)
  const queryBuilder: Record<string, unknown> = {
    where: vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue(selectResult),
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
      values: vi.fn().mockImplementation(insertFn),
    }),
  };
}

function makeActiveArtifact(overrides?: Record<string, unknown>) {
  return {
    id: 'artifact-1',
    segmentKey: { venueFamily: 'hyperliquid', styleTier: 'standard', universeScopeHash: 'abc123' },
    venueFamily: 'hyperliquid',
    styleTier: 'standard',
    universeScopeHash: 'abc123',
    assessedAt: new Date(),
    expiresAt: new Date(Date.now() + 3600_000),
    allowedPresets: ['momentum', 'mean_reversion', 'breakout'],
    presetRankings: [
      { presetKey: 'momentum', rank: 1, score: 85, pros: ['Strong trend following'], cons: [], fitNotes: null },
      { presetKey: 'mean_reversion', rank: 2, score: 72, pros: [], cons: ['Choppy conditions'], fitNotes: null },
    ],
    confidence: 0.8,
    urgency: 'medium',
    currentMarketSummary: 'Bullish momentum',
    regimeSummary: 'Trending up',
    scanHealthSummary: 'Healthy',
    status: 'active',
    ...overrides,
  };
}

describe('change_strategy_preset', () => {
  beforeEach(() => {
    // Reset the module-level port between tests so each test starts clean.
    clearPresetTransitionPort();
  });

  // ── Valid params → success ─────────────────────────────────────────────

  it('records transition and returns success for valid params', async () => {
    const artifact = makeActiveArtifact();
    const mockPort = makeMockTransitionPort();
    setPresetTransitionPort(mockPort);

    const ctx = makeCtx({
      db: makeMockDb({ selectResult: [artifact] }),
    });

    const result = await changeStrategyPresetTool.execute(
      { assessmentArtifactId: 'artifact-1', targetPreset: 'momentum', mode: 'entries_only', reason: 'Market shifted bullish' },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      applied: true,
      targetPreset: 'momentum',
      mode: 'entries_only',
      transitionId: 'transition-1',
      state: 'applied',
    });
    expect(mockPort.applyTransition).toHaveBeenCalledOnce();
    const call = (mockPort.applyTransition as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.agentId).toBe('agent-1');
    expect(call.assessmentArtifactId).toBe('artifact-1');
    expect(call.targetPreset).toBe('momentum');
    expect(call.mode).toBe('entries_only');
    expect(call.reason).toBe('Market shifted bullish');
    expect(call.idempotencyKey).toBeTypeOf('string');
  });

  it('returns artifact_not_found for non-existent assessment artifact', async () => {
    const insertSpy = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({
      db: makeMockDb({ selectResult: [], insertFn: insertSpy }),
    });

    const result = await changeStrategyPresetTool.execute(
      { assessmentArtifactId: 'non_existent', targetPreset: 'custom_preset', mode: 'entries_only' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('assessment.artifact_not_found');
  });

  it('journals the transition via agentConfigOps', async () => {
    const artifact = makeActiveArtifact();
    const appendJournal = vi.fn().mockResolvedValue(undefined);
    const mockPort = makeMockTransitionPort();
    setPresetTransitionPort(mockPort);

    const ctx = makeCtx({
      db: makeMockDb({ selectResult: [artifact] }),
      agentConfigOps: {
        getCurrentConfig: vi.fn().mockResolvedValue({ platformAssessment: { enabled: true } }),
        persistConfig: vi.fn(),
        appendJournal,
        notifyActorConfigUpdate: vi.fn(),
        getLlmTickCount: vi.fn().mockReturnValue(0),
      },
    });

    await changeStrategyPresetTool.execute(
      { assessmentArtifactId: 'artifact-1', targetPreset: 'momentum', mode: 'entries_only', reason: 'Better momentum signal' },
      ctx,
    );

    expect(appendJournal).toHaveBeenCalledOnce();
    const journalCall = appendJournal.mock.calls[0] as [string, Record<string, unknown>];
    expect(journalCall[0]).toBe('preset_transition');
    expect(journalCall[1]).toMatchObject({
      targetPreset: 'momentum',
      mode: 'entries_only',
      reason: 'Better momentum signal',
      transitionId: 'transition-1',
      state: 'applied',
    });
  });

  // ── Invalid mode → validation error ────────────────────────────────────

  it('rejects invalid mode', async () => {
    const ctx = makeCtx();

    const result = await changeStrategyPresetTool.execute(
      { assessmentArtifactId: 'artifact-1', targetPreset: 'momentum', mode: 'invalid_mode' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('validation.invalid_params');
  });

  // ── Missing targetPreset → validation error ────────────────────────────

  it('rejects missing targetPreset', async () => {
    const ctx = makeCtx();

    const result = await changeStrategyPresetTool.execute(
      { assessmentArtifactId: 'artifact-1', mode: 'entries_only' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('validation.invalid_params');
  });

  // ── Preset not allowed by assessment → rejected ────────────────────────

  it('rejects preset not in assessment allowedPresets', async () => {
    const artifact = makeActiveArtifact({ allowedPresets: ['momentum', 'breakout'] });
    const ctx = makeCtx({
      db: makeMockDb({ selectResult: [artifact] }),
    });

    const result = await changeStrategyPresetTool.execute(
      { assessmentArtifactId: 'artifact-1', targetPreset: 'mean_reversion', mode: 'entries_only' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('transition.preset_not_allowed');
    expect(result.error).toContain('mean_reversion');
    expect(result.error).toContain('momentum');
    expect(result.error).toContain('breakout');
  });

  it('allows preset when allowedPresets is empty (no restriction)', async () => {
    const artifact = makeActiveArtifact({ allowedPresets: [] });
    const mockPort = makeMockTransitionPort();
    setPresetTransitionPort(mockPort);

    const ctx = makeCtx({
      db: makeMockDb({ selectResult: [artifact] }),
    });

    const result = await changeStrategyPresetTool.execute(
      { assessmentArtifactId: 'artifact-1', targetPreset: 'any_preset', mode: 'entries_only' },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(mockPort.applyTransition).toHaveBeenCalledOnce();
  });

  // ── DB unavailable → error ─────────────────────────────────────────────

  it('returns error when db is unavailable', async () => {
    const ctx = makeCtx({ db: undefined });

    const result = await changeStrategyPresetTool.execute(
      { assessmentArtifactId: 'artifact-1', targetPreset: 'momentum', mode: 'entries_only' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('db.unavailable');
  });

  // ── enabled: true gate allows transitions ───────────────────────────

  it('succeeds when platformAssessment is enabled', async () => {
    const artifact = makeActiveArtifact();
    const mockPort = makeMockTransitionPort();
    setPresetTransitionPort(mockPort);

    const ctx = makeCtx({
      db: makeMockDb({ selectResult: [artifact] }),
      agentConfigOps: {
        getCurrentConfig: vi.fn().mockResolvedValue({
          platformAssessment: { enabled: true },
        }),
        persistConfig: vi.fn(),
        appendJournal: vi.fn(),
        notifyActorConfigUpdate: vi.fn(),
        getLlmTickCount: vi.fn().mockReturnValue(0),
      },
    });

    const result = await changeStrategyPresetTool.execute(
      { assessmentArtifactId: 'artifact-1', targetPreset: 'momentum', mode: 'entries_only' },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ applied: true, targetPreset: 'momentum' });
    expect(mockPort.applyTransition).toHaveBeenCalledOnce();
  });

  // ── platformAssessment not enabled blocks transitions ──────────────

  it('blocks transition when platformAssessment is not enabled', async () => {
    const ctx = makeCtx({
      agentConfigOps: {
        getCurrentConfig: vi.fn().mockResolvedValue({ platformAssessment: { enabled: false } }),
        persistConfig: vi.fn(),
        appendJournal: vi.fn(),
        notifyActorConfigUpdate: vi.fn(),
        getLlmTickCount: vi.fn().mockReturnValue(0),
      },
    });

    const result = await changeStrategyPresetTool.execute(
      { assessmentArtifactId: 'artifact-1', targetPreset: 'momentum', mode: 'entries_only' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('assessment.not_enabled');
  });

  // ── P6: Exact artifact reference preservation ──────────────────────────

  it('uses the exact artifact reference, not a substituted later artifact', async () => {
    // Two artifacts share the same canonical identity (same symbol, venueFamily,
    // instrumentKind, styleTier) but differ in ID and allowedPresets.
    // artifact-2 is fresher and has a different allowed set.
    // The agent specifies artifact-1 — the tool must use artifact-1, never artifact-2.
    const artifact1 = makeActiveArtifact({
      id: 'artifact-1',
      allowedPresets: ['momentum_v1'],
      symbol: 'BTC',
    });

    const mockPort = makeMockTransitionPort();
    setPresetTransitionPort(mockPort);

    // Both artifacts exist in the DB, but the tool queries by exact
    // assessmentArtifactId (eq(id, 'artifact-1')), so only artifact-1
    // should match. We verify this by spying on the query builder chain.
    const whereSpy = vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue([artifact1]),
      orderBy: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([artifact1]),
      }),
    });
    const fromSpy = vi.fn().mockReturnValue({ where: whereSpy });
    const selectSpy = vi.fn().mockReturnValue({ from: fromSpy });

    const db = {
      select: selectSpy,
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    };

    const ctx = makeCtx({ db: db as unknown as ToolContext['db'] });

    const result = await changeStrategyPresetTool.execute(
      { assessmentArtifactId: 'artifact-1', targetPreset: 'momentum_v1', mode: 'entries_only' },
      ctx,
    );

    // Should succeed using artifact-1's allowedPresets (momentum_v1),
    // not artifact-2's (scalper_v1). If artifact-2 were incorrectly used,
    // the tool would reject with preset_not_allowed.
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      applied: true,
      targetPreset: 'momentum_v1',
      assessmentArtifactId: 'artifact-1',
    });

    // Verify the tool queried the right table by exact artifact ID,
    // not by a looser identity match that could pick up artifact-2.
    expect(fromSpy).toHaveBeenCalledWith(marketAssessmentArtifacts);
    expect(whereSpy).toHaveBeenCalled();
    // eq(column, value) produces a single SQL condition argument.
    expect(whereSpy.mock.calls[0]).toHaveLength(1);

    // Verify the transition port was called with the exact artifact-1 ID.
    expect(mockPort.applyTransition).toHaveBeenCalledOnce();
    const portCall = (mockPort.applyTransition as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(portCall.assessmentArtifactId).toBe('artifact-1');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // M2: Tightening-mode rejection (entries_and_tighten_existing)
  // ═══════════════════════════════════════════════════════════════════════

  it('rejects entries_and_tighten_existing mode as unsupported', async () => {
    const ctx = makeCtx();

    const result = await changeStrategyPresetTool.execute(
      { assessmentArtifactId: 'artifact-1', targetPreset: 'momentum', mode: 'entries_and_tighten_existing' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('transition.unsupported_mode');
    expect(result.error).toContain('entries_and_tighten_existing');
    expect(result.error).toContain('entries_only');
  });

  it('rejects entries_and_full_transition mode as unsupported', async () => {
    const ctx = makeCtx();

    const result = await changeStrategyPresetTool.execute(
      { assessmentArtifactId: 'artifact-1', targetPreset: 'momentum', mode: 'entries_and_full_transition', reason: 'Full migration' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('transition.unsupported_mode');
    expect(result.error).toContain('entries_and_full_transition');
  });

  it('rejects tightening mode before any DB query or port call', async () => {
    // Verify the rejection gate fires before the DB is even touched.
    // Use a DB mock that would throw if accessed — the gate should
    // short-circuit before any DB interaction.
    const throwingDb = new Proxy({} as Record<string, unknown>, {
      get() {
        throw new Error('DB should not be accessed for tightening-mode rejection');
      },
    });
    const ctx = makeCtx({ db: throwingDb as unknown as ToolContext['db'] });

    const result = await changeStrategyPresetTool.execute(
      { assessmentArtifactId: 'artifact-1', targetPreset: 'momentum', mode: 'entries_and_tighten_existing' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('transition.unsupported_mode');
  });

  it('allows entries_only mode through the gate', async () => {
    const artifact = makeActiveArtifact();
    const mockPort = makeMockTransitionPort();
    setPresetTransitionPort(mockPort);

    const ctx = makeCtx({
      db: makeMockDb({ selectResult: [artifact] }),
    });

    const result = await changeStrategyPresetTool.execute(
      { assessmentArtifactId: 'artifact-1', targetPreset: 'momentum', mode: 'entries_only' },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      applied: true,
      targetPreset: 'momentum',
      mode: 'entries_only',
    });
    expect(mockPort.applyTransition).toHaveBeenCalledOnce();
  });


});


// ═══════════════════════════════════════════════════════════════════════════
// Phase 3: Broker denial reply handling (broker-mediated path)
// ═══════════════════════════════════════════════════════════════════════════

describe('change_strategy_preset — broker denial reply', () => {
  beforeEach(() => {
    // Ensure port is cleared so the broker-mediated path is taken
    clearPresetTransitionPort();
  });

  function makeBrokerCtx(blpopReply: unknown): ToolContext {
    return makeCtx({
      redis: {
        hset: vi.fn(async () => 1),
        hget: vi.fn(async () => null),
        hgetall: vi.fn(async () => null),
        hdel: vi.fn(async () => 0),
        publish: vi.fn(async () => 0),
        blpop: vi.fn(async () => blpopReply),
      },
      publishToInbound: vi.fn(async () => undefined),
    });
  }

  it('returns capability denial ToolResult when broker reply has status: rejected', async () => {
    const denialReply = {
      status: 'rejected',
      code: 'capability_denied:rate_limit_exceeded',
      message: 'Rate limit exceeded for change_strategy_preset',
      retryAfterMs: 8000,
      limit: 3,
      used: 3,
    };
    const ctx = makeBrokerCtx(['key', JSON.stringify(denialReply)]);

    const result = await changeStrategyPresetTool.execute(
      { assessmentArtifactId: 'art-1', targetPreset: 'momentum', mode: 'entries_only' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('capability_denied:rate_limit_exceeded');
    expect(result.error).toBe('Rate limit exceeded for change_strategy_preset');
    expect(result.retryable).toBe(true);
    expect(result.fault).toBe(false);
    expect(result.data).toMatchObject({
      retryAfterMs: 8000,
      limit: 3,
      used: 3,
    });
  });

  it('returns capability denial with retryable: false for non-transient denial', async () => {
    const denialReply = {
      status: 'rejected',
      code: 'capability_denied:capability_disabled',
      message: 'change_strategy_preset is disabled',
    };
    const ctx = makeBrokerCtx(['key', JSON.stringify(denialReply)]);

    const result = await changeStrategyPresetTool.execute(
      { assessmentArtifactId: 'art-1', targetPreset: 'momentum', mode: 'entries_only' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('capability_denied:capability_disabled');
    expect(result.retryable).toBe(false);
  });

  it('falls through to normal handler reply when status is not rejected', async () => {
    const normalReply = {
      result: {
        success: true,
        data: {
          applied: true,
          targetPreset: 'momentum',
          mode: 'entries_only',
          transitionId: 'tr-1',
          state: 'applied',
        },
      },
    };
    const ctx = makeBrokerCtx(['key', JSON.stringify(normalReply)]);

    const result = await changeStrategyPresetTool.execute(
      { assessmentArtifactId: 'art-1', targetPreset: 'momentum', mode: 'entries_only' },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      applied: true,
      targetPreset: 'momentum',
    });
  });

  it('returns capability denial with max_concurrent retryable', async () => {
    const denialReply = {
      status: 'rejected',
      code: 'capability_denied:max_concurrent_exceeded',
      message: 'Too many concurrent change requests',
      limit: 1,
      used: 1,
    };
    const ctx = makeBrokerCtx(['key', JSON.stringify(denialReply)]);

    const result = await changeStrategyPresetTool.execute(
      { assessmentArtifactId: 'art-1', targetPreset: 'breakout', mode: 'entries_only' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.data).toMatchObject({ limit: 1, used: 1 });
  });

  it('uses fallback message when denial reply has no message field', async () => {
    const denialReply = {
      status: 'rejected',
      code: 'capability_denied:some_reason',
    };
    const ctx = makeBrokerCtx(['key', JSON.stringify(denialReply)]);

    const result = await changeStrategyPresetTool.execute(
      { assessmentArtifactId: 'art-1', targetPreset: 'momentum', mode: 'entries_only' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Capability denied');
  });
});
