import { describe, it, expect, vi } from 'vitest';
import type { MarketAssessmentIdentity, TradertonReadResult } from '@herobids/domain';
import { createEvidencePorts, type AssessmentReadBoundary } from './evidence-adapters.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeIdentity(
  overrides?: Partial<Extract<MarketAssessmentIdentity, { instrumentKind: 'orderbook' | 'perp' }>>,
): MarketAssessmentIdentity {
  return {
    instrumentKind: 'perp',
    venueFamily: 'hyperliquid-orderbook',
    styleTier: 'standard',
    symbol: 'BTC',
    ...overrides,
  };
}

/**
 * A read boundary that routes by toolName so the candle adapter's two calls
 * (get_volatility + score_candidate) can be stubbed independently. Records every
 * invocation for assertion.
 */
function routingBoundary(routes: {
  get_volatility?: TradertonReadResult;
  score_candidate?: TradertonReadResult;
}): { boundary: AssessmentReadBoundary; invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn(async (input: { toolName: string; payload: unknown }) => {
    const result = routes[input.toolName as keyof typeof routes];
    if (!result) {
      throw new Error(`unexpected toolName in test: ${input.toolName}`);
    }
    return result;
  });
  return { boundary: { invoke }, invoke };
}

// D1-b rework: get_volatility now returns the FULL VolatilityEvidence derived
// Traderton-side (absolute-units ATR + percentile-classified regime + version
// '1.0.0'), alongside the unchanged volatilityPct scalar. The consumer passes
// volatilityEvidence through verbatim; a null volatilityEvidence maps to null.
const VOLATILITY_SUCCESS = (
  volatilityEvidence:
    | { averageTrueRange: number; volatilityRegime: 'low' | 'normal' | 'high' | 'extreme'; calculationVersion: string }
    | null,
  volatilityPct: number | null = null,
): TradertonReadResult => ({
  kind: 'success',
  data: { ok: true, volatilityPct, volatilityEvidence },
});

const SCORE_SUCCESS = (
  candlesEvaluated: number,
  candleWindow: { start: string; end: string } | null,
): TradertonReadResult => ({
  kind: 'success',
  data: { signal: { confidence: 0.5 }, candlesEvaluated, candleWindow },
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('createEvidencePorts — candles adapter (D1-b derived reads)', () => {
  it('derives volatility from get_volatility and window/count from score_candidate', async () => {
    const window = { start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T12:00:00.000Z' };
    const { boundary, invoke } = routingBoundary({
      get_volatility: VOLATILITY_SUCCESS(
        { averageTrueRange: 125.5, volatilityRegime: 'high', calculationVersion: '1.0.0' },
        1.5,
      ),
      score_candidate: SCORE_SUCCESS(24, window),
    });
    const ports = createEvidencePorts({ readBoundary: boundary });

    const result = await ports.candles.getCandles({
      identity: makeIdentity(),
      interval: '15m',
      minimumCandles: 48,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    const derived = result.data.data;

    // D1-b rework: volatilityEvidence is passed through VERBATIM from the boundary
    // (Traderton-derived). The absolute-units ATR is preserved unchanged (H1 guard —
    // NOT reconstructed from volatilityPct), the percentile regime label is preserved
    // (H2 guard — NOT reclassified from an invented band), and the version is '1.0.0'.
    expect(derived.volatility).not.toBeNull();
    expect(derived.volatility?.averageTrueRange).toBe(125.5);
    expect(derived.volatility?.volatilityRegime).toBe('high');
    expect(derived.volatility?.calculationVersion).toBe('1.0.0');
    // Window + count from score_candidate.
    expect(derived.candleWindow).toEqual(window);
    expect(derived.candlesEvaluated).toBe(24);

    // Boundary called for BOTH derived reads with the provider symbol.
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenNthCalledWith(1, { toolName: 'get_volatility', payload: { symbol: 'BTC' } });
    expect(invoke.mock.calls[1]![0]!.toolName).toBe('score_candidate');
  });

  it('passes each percentile-classified regime label through verbatim (H2 guard)', async () => {
    // The regime label is classified Traderton-side by percentile of the candle TR
    // distribution; the consumer must pass it through unchanged, whatever the label.
    const regimes: Array<'low' | 'normal' | 'high' | 'extreme'> = ['low', 'normal', 'high', 'extreme'];
    for (const regime of regimes) {
      const { boundary } = routingBoundary({
        get_volatility: VOLATILITY_SUCCESS(
          { averageTrueRange: 12.34, volatilityRegime: regime, calculationVersion: '1.0.0' },
        ),
        score_candidate: SCORE_SUCCESS(48, { start: 'a', end: 'b' }),
      });
      const ports = createEvidencePorts({ readBoundary: boundary });
      const result = await ports.candles.getCandles({ identity: makeIdentity(), interval: '15m', minimumCandles: 48 });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.data.data.volatility?.volatilityRegime).toBe(regime);
    }
  });

  it('preserves the absolute-units averageTrueRange exactly (H1 regression guard)', async () => {
    // The boundary ATR (absolute price units) must arrive unchanged — NOT rounded,
    // rescaled, or reconstructed from the volatilityPct percentage scalar. A large
    // absolute ATR (125.5) alongside a small percentage (1.5%) proves they are
    // distinct fields and that the consumer keeps the absolute ATR.
    const { boundary } = routingBoundary({
      get_volatility: VOLATILITY_SUCCESS(
        { averageTrueRange: 125.5, volatilityRegime: 'normal', calculationVersion: '1.0.0' },
        1.5,
      ),
      score_candidate: SCORE_SUCCESS(48, { start: 'a', end: 'b' }),
    });
    const ports = createEvidencePorts({ readBoundary: boundary });
    const result = await ports.candles.getCandles({ identity: makeIdentity(), interval: '15m', minimumCandles: 48 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.data.volatility?.averageTrueRange).toBe(125.5);
  });

  it('maps a null volatilityEvidence to null volatility evidence (not an error)', async () => {
    const { boundary } = routingBoundary({
      get_volatility: VOLATILITY_SUCCESS(null),
      score_candidate: SCORE_SUCCESS(48, { start: 'a', end: 'b' }),
    });
    const ports = createEvidencePorts({ readBoundary: boundary });

    const result = await ports.candles.getCandles({ identity: makeIdentity(), interval: '15m', minimumCandles: 48 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.data.volatility).toBeNull();
  });

  it('maps a null candleWindow / zero count through as derived metadata', async () => {
    const { boundary } = routingBoundary({
      get_volatility: VOLATILITY_SUCCESS(
        { averageTrueRange: 0.5, volatilityRegime: 'normal', calculationVersion: '1.0.0' },
      ),
      score_candidate: SCORE_SUCCESS(0, null),
    });
    const ports = createEvidencePorts({ readBoundary: boundary });

    const result = await ports.candles.getCandles({ identity: makeIdentity(), interval: '15m', minimumCandles: 48 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.data.candleWindow).toBeNull();
    expect(result.data.data.candlesEvaluated).toBe(0);
  });

  it('returns a structured error when get_volatility fails', async () => {
    const { boundary, invoke } = routingBoundary({
      get_volatility: { kind: 'failure', code: 'upstream.down', message: 'provider down', retryable: true },
    });
    const ports = createEvidencePorts({ readBoundary: boundary });

    const result = await ports.candles.getCandles({ identity: makeIdentity(), interval: '15m', minimumCandles: 48 });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error.code).toBe('assessment.candles_failed');
    // Short-circuits before score_candidate is called.
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('returns a structured error when score_candidate is unreachable', async () => {
    const { boundary } = routingBoundary({
      get_volatility: VOLATILITY_SUCCESS(
        { averageTrueRange: 0.5, volatilityRegime: 'normal', calculationVersion: '1.0.0' },
      ),
      score_candidate: { kind: 'transport_error', message: 'connection reset' },
    });
    const ports = createEvidencePorts({ readBoundary: boundary });

    const result = await ports.candles.getCandles({ identity: makeIdentity(), interval: '15m', minimumCandles: 48 });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error.code).toBe('assessment.evidence_unavailable');
  });

  it('maps an in_progress read to a structured unavailable error', async () => {
    const { boundary } = routingBoundary({
      get_volatility: { kind: 'in_progress' },
    });
    const ports = createEvidencePorts({ readBoundary: boundary });

    const result = await ports.candles.getCandles({ identity: makeIdentity(), interval: '15m', minimumCandles: 48 });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error.code).toBe('assessment.evidence_unavailable');
  });

  it('returns evidence_unavailable when the read boundary is not configured', async () => {
    const ports = createEvidencePorts({});

    const result = await ports.candles.getCandles({ identity: makeIdentity(), interval: '15m', minimumCandles: 48 });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error.code).toBe('assessment.evidence_unavailable');
  });

  it('returns unsupported_identity for swap/dex identities', async () => {
    const { boundary, invoke } = routingBoundary({});
    const ports = createEvidencePorts({ readBoundary: boundary });

    const result = await ports.candles.getCandles({
      identity: { instrumentKind: 'swap', venueFamily: 'jupiter', styleTier: 'economy', network: 'solana', address: '0xabc' },
      interval: '15m',
      minimumCandles: 48,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error.code).toBe('assessment.evidence_unsupported_identity');
    // No boundary call for an unsupported identity.
    expect(invoke).not.toHaveBeenCalled();
  });
});
