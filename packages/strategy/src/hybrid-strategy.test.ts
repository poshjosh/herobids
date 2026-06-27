import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HybridStrategy } from './hybrid-strategy.js';
import type { MechanicalStrategy } from './mechanical-strategy.js';
import type { LlmStrategy } from './llm.js';
import type { MarketSnapshot, Decision, DecisionId, InstrumentId, VenueAccountId } from '@herobids/domain';
import { price, ok, err, quantity } from '@herobids/domain';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SYMBOL = 'BTC/USDT';

const BASE_SNAPSHOT: MarketSnapshot = {
  symbol: SYMBOL,
  price: price('50000'),
  timestamp: '2026-01-01T00:00:00Z',
};

const BASE_CONFIG = {
  mechanical: { positionSize: '100', stopLossPct: 5, takeProfitPct: 10 },
  provider: 'openai',
  lightModel: 'gpt-4o-mini',
};

function makeDecision(intent: 'go_long' | 'go_flat', metadata?: Record<string, unknown>): Decision {
  return {
    id: 'dec-1' as DecisionId,
    venueAccountId: '' as VenueAccountId,
    instrumentId: SYMBOL as InstrumentId,
    actorType: 'system',
    actorId: 'mechanical-v1',
    intent,
    targetSize: quantity('100'),
    timestamp: BASE_SNAPSHOT.timestamp,
    metadata,
  };
}

function makeMechanical(result: Awaited<ReturnType<MechanicalStrategy['evaluate']>>): MechanicalStrategy {
  return { id: 'mechanical-v1', name: 'Mechanical Strategy', evaluate: vi.fn().mockResolvedValue(result) } as unknown as MechanicalStrategy;
}

function makeLlm(result: Awaited<ReturnType<LlmStrategy['evaluate']>>): LlmStrategy {
  return { id: 'llm-v1', name: 'LLM Strategy', evaluate: vi.fn().mockResolvedValue(result) } as unknown as LlmStrategy;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('HybridStrategy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null and does not call LLM when mechanical returns null', async () => {
    const mechanical = makeMechanical(ok(null));
    const llm = makeLlm(ok(null));
    const strategy = new HybridStrategy(mechanical, llm);

    const result = await strategy.evaluate(BASE_SNAPSHOT, BASE_CONFIG);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBeNull();
    expect(vi.mocked(llm.evaluate)).not.toHaveBeenCalled();
  });

  it('calls LLM and returns its decision when mechanical returns go_long', async () => {
    const mechanicalDecision = makeDecision('go_long', {
      confidence: 0.75,
      reasons: ['RSI healthy', 'MACD crossover'],
      indicators: { rsi: 55 },
    });
    const llmDecision = makeDecision('go_long');
    const mechanical = makeMechanical(ok(mechanicalDecision));
    const llm = makeLlm(ok(llmDecision));
    const strategy = new HybridStrategy(mechanical, llm);

    const result = await strategy.evaluate(BASE_SNAPSHOT, BASE_CONFIG);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data?.intent).toBe('go_long');
    expect(vi.mocked(llm.evaluate)).toHaveBeenCalledOnce();
  });

  it('injects mechanical indicator data into snapshot before calling LLM', async () => {
    const mechanicalDecision = makeDecision('go_long', {
      confidence: 0.8,
      reasons: ['strong momentum'],
      indicators: { rsi: 60 },
    });
    const mechanical = makeMechanical(ok(mechanicalDecision));
    const llm = makeLlm(ok(null));
    const strategy = new HybridStrategy(mechanical, llm);

    await strategy.evaluate(BASE_SNAPSHOT, BASE_CONFIG);

    const passedSnapshot = vi.mocked(llm.evaluate).mock.calls[0]?.[0] as MarketSnapshot;
    expect(passedSnapshot.data?.['mechanical_confidence']).toBe(0.8);
    expect(passedSnapshot.data?.['mechanical_reasons']).toEqual(['strong momentum']);
    expect(passedSnapshot.data?.['mechanical_indicators']).toEqual({ rsi: 60 });
  });

  it('propagates go_flat from mechanical without calling LLM', async () => {
    const flatDecision = makeDecision('go_flat');
    const mechanical = makeMechanical(ok(flatDecision));
    const llm = makeLlm(ok(null));
    const strategy = new HybridStrategy(mechanical, llm);

    const result = await strategy.evaluate(BASE_SNAPSHOT, BASE_CONFIG);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data?.intent).toBe('go_flat');
    expect(vi.mocked(llm.evaluate)).not.toHaveBeenCalled();
  });

  it('propagates errors from mechanical without calling LLM', async () => {
    const mechanical = makeMechanical(err({ code: 'strategy.candle_fetch_failed', message: 'network error' }));
    const llm = makeLlm(ok(null));
    const strategy = new HybridStrategy(mechanical, llm);

    const result = await strategy.evaluate(BASE_SNAPSHOT, BASE_CONFIG);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('strategy.candle_fetch_failed');
    }
    expect(vi.mocked(llm.evaluate)).not.toHaveBeenCalled();
  });

  it('propagates LLM error when mechanical returns go_long and LLM returns error', async () => {
    const mechanicalDecision = makeDecision('go_long');
    const mechanical = makeMechanical(ok(mechanicalDecision));
    const llm = makeLlm(err({ code: 'strategy.llm_failed', message: 'LLM unavailable' }));
    const strategy = new HybridStrategy(mechanical, llm);

    const result = await strategy.evaluate(BASE_SNAPSHOT, BASE_CONFIG);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('strategy.llm_failed');
    }
  });

  it('preserves existing snapshot.data fields after mechanical enrichment', async () => {
    const snapshotWithData: MarketSnapshot = {
      ...BASE_SNAPSHOT,
      data: { newPositionsToday: 2 },
    };
    const mechanicalDecision = makeDecision('go_long', { confidence: 0.9 });
    const mechanical = makeMechanical(ok(mechanicalDecision));
    const llm = makeLlm(ok(null));
    const strategy = new HybridStrategy(mechanical, llm);

    await strategy.evaluate(snapshotWithData, BASE_CONFIG);

    const passedSnapshot = vi.mocked(llm.evaluate).mock.calls[0]?.[0] as MarketSnapshot;
    expect(passedSnapshot.data?.['newPositionsToday']).toBe(2);
    expect(passedSnapshot.data?.['mechanical_confidence']).toBe(0.9);
  });

  it('propagates null from LLM (hold) when mechanical returns go_long', async () => {
    const mechanicalDecision = makeDecision('go_long');
    const mechanical = makeMechanical(ok(mechanicalDecision));
    const llm = makeLlm(ok(null));
    const strategy = new HybridStrategy(mechanical, llm);

    const result = await strategy.evaluate(BASE_SNAPSHOT, BASE_CONFIG);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBeNull();
    expect(vi.mocked(llm.evaluate)).toHaveBeenCalledOnce();
  });
});
