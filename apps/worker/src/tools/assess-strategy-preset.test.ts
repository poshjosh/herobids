import { describe, it, expect, vi } from 'vitest';
import type { ToolContext } from '@herobids/domain';
import { assessStrategyPresetTool } from './assess-strategy-preset.js';

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

  it('returns service unavailable when AssessmentRequestService is not wired', async () => {
    const ctx = makeCtx({ db: undefined });
    const result = await assessStrategyPresetTool.execute(
      { symbols: ['BTC'], venueFamily: 'hyperliquid', instrumentKind: 'perp' },
      ctx,
    );
    // When service is not wired, the tool returns success with a service_unavailable result
    // for each instrument rather than failing at the DB level.
    expect(result.success).toBe(true);
    if (result.success && result.data) {
      expect(result.data.results[0]?.errorCode).toBe('assessment.service_unavailable');
    }
  });
});
