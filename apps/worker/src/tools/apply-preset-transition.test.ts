import { describe, it, expect, vi } from 'vitest';
import type { ToolContext } from '@herobids/domain';
import { applyPresetTransitionTool } from './apply-preset-transition.js';

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
      getCurrentConfig: vi.fn().mockResolvedValue({}),
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
  // db.select().from(table).where(...).orderBy(...).limit(1)
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

describe('apply_preset_transition', () => {
  // ── Valid params → success ─────────────────────────────────────────────

  it('records transition and returns success for valid params', async () => {
    const artifact = makeActiveArtifact();
    const insertSpy = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({
      db: makeMockDb({ selectResult: [artifact], insertFn: insertSpy }),
    });

    const result = await applyPresetTransitionTool.execute(
      { targetPreset: 'momentum', mode: 'entries_only', reason: 'Market shifted bullish' },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      applied: true,
      targetPreset: 'momentum',
      mode: 'entries_only',
      openPositionCount: 0,
    });
    expect(insertSpy).toHaveBeenCalledOnce();
    const insertCall = insertSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertCall.newPresetKey).toBe('momentum');
    expect(insertCall.transitionMode).toBe('entries_only');
    expect(insertCall.outcome).toBe('accepted');
    expect(insertCall.agentId).toBe('agent-1');
  });

  it('works without an active artifact (no allowed presets constraint)', async () => {
    const insertSpy = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({
      db: makeMockDb({ selectResult: [], insertFn: insertSpy }),
    });

    const result = await applyPresetTransitionTool.execute(
      { targetPreset: 'custom_preset', mode: 'entries_only' },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ applied: true, targetPreset: 'custom_preset' });
  });

  it('journals the transition via agentConfigOps', async () => {
    const artifact = makeActiveArtifact();
    const appendJournal = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({
      db: makeMockDb({ selectResult: [artifact] }),
      agentConfigOps: {
        getCurrentConfig: vi.fn().mockResolvedValue({}),
        persistConfig: vi.fn(),
        appendJournal,
        notifyActorConfigUpdate: vi.fn(),
        getLlmTickCount: vi.fn().mockReturnValue(0),
      },
    });

    await applyPresetTransitionTool.execute(
      { targetPreset: 'momentum', mode: 'entries_and_tighten_existing', reason: 'Better momentum signal' },
      ctx,
    );

    expect(appendJournal).toHaveBeenCalledOnce();
    const journalCall = appendJournal.mock.calls[0] as [string, Record<string, unknown>];
    expect(journalCall[0]).toBe('preset_transition');
    expect(journalCall[1]).toMatchObject({
      targetPreset: 'momentum',
      mode: 'entries_and_tighten_existing',
      oldPresetKey: 'unknown',
    });
  });

  // ── Invalid mode → validation error ────────────────────────────────────

  it('rejects invalid mode', async () => {
    const ctx = makeCtx();

    const result = await applyPresetTransitionTool.execute(
      { targetPreset: 'momentum', mode: 'invalid_mode' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('validation.invalid_params');
  });

  // ── Missing targetPreset → validation error ────────────────────────────

  it('rejects missing targetPreset', async () => {
    const ctx = makeCtx();

    const result = await applyPresetTransitionTool.execute(
      { mode: 'entries_only' },
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

    const result = await applyPresetTransitionTool.execute(
      { targetPreset: 'mean_reversion', mode: 'entries_only' },
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
    const insertSpy = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({
      db: makeMockDb({ selectResult: [artifact], insertFn: insertSpy }),
    });

    const result = await applyPresetTransitionTool.execute(
      { targetPreset: 'any_preset', mode: 'entries_only' },
      ctx,
    );

    expect(result.success).toBe(true);
  });

  // ── DB unavailable → error ─────────────────────────────────────────────

  it('returns error when db is unavailable', async () => {
    const ctx = makeCtx({ db: undefined });

    const result = await applyPresetTransitionTool.execute(
      { targetPreset: 'momentum', mode: 'entries_only' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('db.unavailable');
  });
});
