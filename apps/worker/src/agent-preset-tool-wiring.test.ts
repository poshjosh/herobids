import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '@herobids/domain';
import { AGENT_MESSAGE_TYPES } from '@herobids/domain';
import { createToolRegistry } from './tools/index.js';
import { setAssessmentRequestPort } from './tools/assess-strategy-preset.js';
import { setPresetTransitionPort } from './tools/change-strategy-preset.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const redis = {
    hset: vi.fn().mockResolvedValue(1),
    hget: vi.fn().mockResolvedValue(null),
    hgetall: vi.fn().mockResolvedValue(null),
    hdel: vi.fn().mockResolvedValue(0),
    publish: vi.fn().mockResolvedValue(0),
    blpop: vi.fn().mockResolvedValue(null),
    smembers: vi.fn().mockResolvedValue([]),
    sadd: vi.fn().mockResolvedValue(0),
    srem: vi.fn().mockResolvedValue(0),
    expire: vi.fn().mockResolvedValue(0),
    ...overrides.redis,
  };

  return {
    agentId: 'test-agent',
    sessionId: 'test-session',
    phase: 'scout',
    executionMode: 'paper',
    authorizationMode: 'direct',
    redis,
    publishToInbound: vi.fn().mockResolvedValue(undefined),
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

// ── Tests ──────────────────────────────────────────────────────────────────

describe('agent preset tool wiring', () => {
  beforeEach(() => {
    // Reset module-level ports so the broker-mediated path is exercised.
    // Without this reset, a prior test that wired the port would cause
    // the direct-port path to be used instead of broker mediation.
    setAssessmentRequestPort(null as unknown as Parameters<typeof setAssessmentRequestPort>[0]);
    setPresetTransitionPort(null as unknown as Parameters<typeof setPresetTransitionPort>[0]);
  });

  // ── Registry registration ─────────────────────────────────────────────

  it('registers assess_strategy_preset in the tool registry', () => {
    const registry = createToolRegistry();
    const tool = registry.get('assess_strategy_preset');
    expect(tool).toBeDefined();
    expect(tool?.name).toBe('assess_strategy_preset');
  });

  it('registers change_strategy_preset in the tool registry', () => {
    const registry = createToolRegistry();
    const tool = registry.get('change_strategy_preset');
    expect(tool).toBeDefined();
    expect(tool?.name).toBe('change_strategy_preset');
  });

  // ── Broker-mediated assess_strategy_preset ─────────────────────────────

  it('assess_strategy_preset publishes to broker and returns the broker response', async () => {
    const ctx = makeCtx();
    const publishToInbound = ctx.publishToInbound as ReturnType<typeof vi.fn>;

    // Simulate a broker response with a completed assessment
    (ctx.redis.blpop as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      'agent:preset:reply:mock-id',
      JSON.stringify({
        result: {
          success: true,
          data: {
            requestedInstrumentCount: 1,
            assessedInstrumentCount: 1,
            maxInstrumentsPerRequest: 3,
            results: [
              {
                success: true,
                symbol: 'BTC',
                canonicalIdentity: {
                  instrumentKind: 'perp',
                  venueFamily: 'hyperliquid',
                  styleTier: 'standard',
                  symbol: 'BTC',
                },
                assessment: {
                  artifactId: 'test-artifact-id',
                  assessedAt: new Date().toISOString(),
                  expiresAt: new Date(Date.now() + 3600000).toISOString(),
                  marketSummary: 'Bullish market structure',
                  regimeSummary: 'Strong uptrend',
                  scanHealthSummary: 'All scans clear',
                  rankings: [
                    {
                      presetKey: 'momentum',
                      score: 85,
                      grade: 'A',
                      strengths: ['Strong trend following'],
                      weaknesses: ['Noisy in ranging markets'],
                    },
                  ],
                  recommendedPreset: 'momentum',
                  allowedPresets: ['momentum', 'mean_reversion'],
                  freshnessNote: 'Valid for approximately 1 hour.',
                  confidence: 85,
                  urgency: 'low',
                },
                transitionReference: {
                  assessmentArtifactId: 'test-artifact-id',
                },
                billing: {
                  billed: true,
                  requestId: 'req-1',
                  idempotencyKey: null,
                  source: 'new_run',
                },
              },
            ],
          },
        },
      }),
    ]);

    const registry = createToolRegistry();
    const tool = registry.get('assess_strategy_preset');
    expect(tool).toBeDefined();

    const result = await tool!.execute(
      { symbols: ['BTC'], venueFamily: 'hyperliquid', instrumentKind: 'perp' },
      ctx,
    );

    // Should NOT be service_unavailable — the broker returned a real result
    expect(result.success).toBe(true);
    if (result.success && result.data) {
      const data = result.data as { results: Array<{ errorCode?: string }> };
      expect(data.results[0]?.errorCode).not.toBe('assessment.service_unavailable');
      expect(data.results[0]?.success).toBe(true);
    }

    // Should have published the correct message type to the inbound stream
    expect(publishToInbound).toHaveBeenCalledWith(
      AGENT_MESSAGE_TYPES.TOOL_ASSESS_STRATEGY_PRESET,
      expect.objectContaining({
        agentId: 'test-agent',
        sessionId: 'test-session',
        symbols: ['BTC'],
        venueFamily: 'hyperliquid',
        instrumentKind: 'perp',
        requestMessageId: expect.any(String),
      }),
    );

    // Should have called blpop to await the broker response
    expect(ctx.redis.blpop).toHaveBeenCalledWith(
      expect.stringMatching(/^agent:preset:reply:/),
      30,
    );
  });

  it('assess_strategy_preset returns broker timeout when blpop returns null', async () => {
    const ctx = makeCtx();
    // blpop defaults to null (timeout), no need to override

    const registry = createToolRegistry();
    const tool = registry.get('assess_strategy_preset');
    expect(tool).toBeDefined();

    const result = await tool!.execute(
      { symbols: ['BTC'], venueFamily: 'hyperliquid', instrumentKind: 'perp' },
      ctx,
    );

    // Should return a timeout error from the broker path
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('broker.timeout');
  });

  it('assess_strategy_preset returns broker.communication_error when publishToInbound rejects', async () => {
    const ctx = makeCtx();
    const publishToInbound = ctx.publishToInbound as ReturnType<typeof vi.fn>;
    publishToInbound.mockRejectedValueOnce(new Error('Redis connection lost'));

    const registry = createToolRegistry();
    const tool = registry.get('assess_strategy_preset');
    expect(tool).toBeDefined();

    const result = await tool!.execute(
      { symbols: ['BTC'], venueFamily: 'hyperliquid', instrumentKind: 'perp' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('broker.communication_error');
  });

  it('assess_strategy_preset returns broker.communication_error when blpop returns unparseable JSON', async () => {
    const ctx = makeCtx();
    (ctx.redis.blpop as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      'agent:preset:reply:mock-id',
      'not valid json',
    ]);

    const registry = createToolRegistry();
    const tool = registry.get('assess_strategy_preset');
    expect(tool).toBeDefined();

    const result = await tool!.execute(
      { symbols: ['BTC'], venueFamily: 'hyperliquid', instrumentKind: 'perp' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('broker.communication_error');
  });

  // ── Broker-mediated change_strategy_preset ─────────────────────────────

  it('change_strategy_preset publishes to broker and returns the broker response', async () => {
    const ctx = makeCtx({
      agentConfigOps: {
        getCurrentConfig: vi.fn().mockResolvedValue({ platformAssessment: { enabled: true } }),
        persistConfig: vi.fn(),
        appendJournal: vi.fn().mockResolvedValue(undefined),
        notifyActorConfigUpdate: vi.fn(),
        getLlmTickCount: vi.fn().mockReturnValue(0),
      },
    });
    const publishToInbound = ctx.publishToInbound as ReturnType<typeof vi.fn>;

    // Simulate a broker response with a successful transition
    (ctx.redis.blpop as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      'agent:preset:reply:mock-id',
      JSON.stringify({
        result: {
          success: true,
          data: {
            applied: true,
            targetPreset: 'momentum',
            mode: 'entries_only',
            assessmentArtifactId: 'test-artifact-id',
            transitionId: 'test-transition-id',
            state: 'applied',
            message: 'Preset transition applied: switched to "momentum" in "entries_only" mode.',
            appliedAt: new Date().toISOString(),
          },
        },
      }),
    ]);

    const registry = createToolRegistry();
    const tool = registry.get('change_strategy_preset');
    expect(tool).toBeDefined();

    const result = await tool!.execute(
      {
        assessmentArtifactId: 'test-artifact-id',
        targetPreset: 'momentum',
        mode: 'entries_only',
        reason: 'Market shifted bullish',
      },
      ctx,
    );

    // Should NOT be service_unavailable — the broker returned a real result
    expect(result.success).toBe(true);
    if (result.success && result.data) {
      const data = result.data as { applied: boolean; transitionId: string };
      expect(data.applied).toBe(true);
      expect(data.transitionId).toBe('test-transition-id');
    }

    // Should have published the correct message type to the inbound stream
    expect(publishToInbound).toHaveBeenCalledWith(
      AGENT_MESSAGE_TYPES.TOOL_CHANGE_STRATEGY_PRESET,
      expect.objectContaining({
        agentId: 'test-agent',
        sessionId: 'test-session',
        assessmentArtifactId: 'test-artifact-id',
        targetPreset: 'momentum',
        mode: 'entries_only',
        reason: 'Market shifted bullish',
        requestMessageId: expect.any(String),
      }),
    );

    // Should have called blpop to await the broker response
    expect(ctx.redis.blpop).toHaveBeenCalledWith(
      expect.stringMatching(/^agent:preset:reply:/),
      30,
    );

    // Should have called getCurrentConfig for the platformAssessment gate
    expect(ctx.agentConfigOps.getCurrentConfig).toHaveBeenCalled();
  });

  it('change_strategy_preset returns broker timeout when blpop returns null', async () => {
    const ctx = makeCtx({
      agentConfigOps: {
        getCurrentConfig: vi.fn().mockResolvedValue({ platformAssessment: { enabled: true } }),
        persistConfig: vi.fn(),
        appendJournal: vi.fn().mockResolvedValue(undefined),
        notifyActorConfigUpdate: vi.fn(),
        getLlmTickCount: vi.fn().mockReturnValue(0),
      },
    });
    // blpop defaults to null (timeout)

    const registry = createToolRegistry();
    const tool = registry.get('change_strategy_preset');
    expect(tool).toBeDefined();

    const result = await tool!.execute(
      {
        assessmentArtifactId: 'test-artifact-id',
        targetPreset: 'momentum',
        mode: 'entries_only',
      },
      ctx,
    );

    // Should return a timeout error from the broker path
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('broker.timeout');
  });

  it('change_strategy_preset returns broker.communication_error when publishToInbound rejects', async () => {
    const ctx = makeCtx({
      agentConfigOps: {
        getCurrentConfig: vi.fn().mockResolvedValue({ platformAssessment: { enabled: true } }),
        persistConfig: vi.fn(),
        appendJournal: vi.fn().mockResolvedValue(undefined),
        notifyActorConfigUpdate: vi.fn(),
        getLlmTickCount: vi.fn().mockReturnValue(0),
      },
    });
    const publishToInbound = ctx.publishToInbound as ReturnType<typeof vi.fn>;
    publishToInbound.mockRejectedValueOnce(new Error('Redis connection lost'));

    const registry = createToolRegistry();
    const tool = registry.get('change_strategy_preset');
    expect(tool).toBeDefined();

    const result = await tool!.execute(
      {
        assessmentArtifactId: 'test-artifact-id',
        targetPreset: 'momentum',
        mode: 'entries_only',
      },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('broker.communication_error');
  });

  it('change_strategy_preset returns broker.communication_error when blpop returns unparseable JSON', async () => {
    const ctx = makeCtx({
      agentConfigOps: {
        getCurrentConfig: vi.fn().mockResolvedValue({ platformAssessment: { enabled: true } }),
        persistConfig: vi.fn(),
        appendJournal: vi.fn().mockResolvedValue(undefined),
        notifyActorConfigUpdate: vi.fn(),
        getLlmTickCount: vi.fn().mockReturnValue(0),
      },
    });
    (ctx.redis.blpop as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      'agent:preset:reply:mock-id',
      'not valid json',
    ]);

    const registry = createToolRegistry();
    const tool = registry.get('change_strategy_preset');
    expect(tool).toBeDefined();

    const result = await tool!.execute(
      {
        assessmentArtifactId: 'test-artifact-id',
        targetPreset: 'momentum',
        mode: 'entries_only',
      },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('broker.communication_error');
  });

  it('change_strategy_preset returns assessment.not_enabled when platformAssessment is disabled and does not call broker', async () => {
    const getCurrentConfig = vi.fn().mockResolvedValue({ platformAssessment: { enabled: false } });
    const ctx = makeCtx({
      agentConfigOps: {
        getCurrentConfig,
        persistConfig: vi.fn(),
        appendJournal: vi.fn().mockResolvedValue(undefined),
        notifyActorConfigUpdate: vi.fn(),
        getLlmTickCount: vi.fn().mockReturnValue(0),
      },
    });
    const publishToInbound = ctx.publishToInbound as ReturnType<typeof vi.fn>;

    const registry = createToolRegistry();
    const tool = registry.get('change_strategy_preset');
    expect(tool).toBeDefined();

    const result = await tool!.execute(
      {
        assessmentArtifactId: 'test-artifact-id',
        targetPreset: 'momentum',
        mode: 'entries_only',
      },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('assessment.not_enabled');

    // Must NOT have attempted broker communication
    expect(publishToInbound).not.toHaveBeenCalled();
    expect(ctx.redis.blpop).not.toHaveBeenCalled();
  });

  // ── Fallback: service_unavailable when neither port nor broker available ──

  it('assess_strategy_preset returns service_unavailable when broker and port are unavailable', async () => {
    // No blpop on redis, no publishToInbound — simulates unit-test context
    const ctx = makeCtx({
      redis: {
        hset: vi.fn().mockResolvedValue(1),
        hget: vi.fn().mockResolvedValue(null),
        hgetall: vi.fn().mockResolvedValue(null),
        hdel: vi.fn().mockResolvedValue(0),
        publish: vi.fn().mockResolvedValue(0),
        // blpop intentionally omitted — this is the sentinel the tool checks
      } as unknown as ToolContext['redis'],
      publishToInbound: undefined as unknown as ToolContext['publishToInbound'],
    });

    const registry = createToolRegistry();
    const tool = registry.get('assess_strategy_preset');
    expect(tool).toBeDefined();

    const result = await tool!.execute(
      { symbols: ['BTC'], venueFamily: 'hyperliquid', instrumentKind: 'perp' },
      ctx,
    );

    expect(result.success).toBe(true);
    if (result.success && result.data) {
      const data = result.data as { results: Array<{ errorCode?: string }> };
      expect(data.results[0]?.errorCode).toBe('assessment.service_unavailable');
    }
  });
});
