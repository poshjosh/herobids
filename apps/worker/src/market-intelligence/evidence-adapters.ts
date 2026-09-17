import type {
  MarketAssessmentIdentity,
  AssessmentData,
  AssessmentUnavailable,
  VolatilityEvidence,
  TradertonReadResult,
} from '@herobids/domain';
import { err, ok, type Result, RegimeResult, ScannerCandleTarget, VolatilityEvidenceSchema } from '@herobids/domain';
import type {
  AssessmentEvidencePorts,
  AssessmentCandleSource,
  AssessmentLiquiditySource,
  AssessmentBreadthSource,
  AssessmentRegimeSource,
  DerivedCandleEvidence,
  CandleInterval,
} from './assessment-ports.js';

// ── Freshness defaults ──────────────────────────────────────────────────────

const DEFAULT_REGIME_FRESHNESS_MS = 5 * 60 * 1000; // 5 min
const DEFAULT_CANDLE_FRESHNESS_MS = 5 * 60 * 1000; // 5 min

// ── Identity → ScannerTarget mapping ───────────────────────────────────────

/** Map an assessment identity to a ScannerCandleTarget, or null if unsupported. */
function identityToScannerTarget(identity: MarketAssessmentIdentity): ScannerCandleTarget | null {
  if (identity.instrumentKind === 'orderbook' || identity.instrumentKind === 'perp') {
    return { venueType: 'orderbook', providerSymbol: identity.symbol };
  }
  return null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** The subset of the boundary `check_regime` success payload the adapter needs. */
interface RegimeBoundaryPayload {
  pass: boolean;
  reasons: string[];
  details: Record<string, unknown>;
  freshness?: { provider: string; source: 'upstream' | 'cache'; ageMs: number; isStale: boolean };
}

/** Narrow the boundary `check_regime` success payload (`unknown` over the wire). */
function parseRegimePayload(data: unknown): RegimeBoundaryPayload {
  const record = (data ?? {}) as Record<string, unknown>;
  const rawFreshness = record['freshness'];
  let freshness: RegimeBoundaryPayload['freshness'];
  if (rawFreshness && typeof rawFreshness === 'object') {
    const f = rawFreshness as Record<string, unknown>;
    freshness = {
      provider: typeof f['provider'] === 'string' ? f['provider'] : 'binance',
      source: f['source'] === 'cache' ? 'cache' : 'upstream',
      ageMs: typeof f['ageMs'] === 'number' ? f['ageMs'] : 0,
      isStale: f['isStale'] === true,
    };
  }
  return {
    pass: record['pass'] === true,
    reasons: Array.isArray(record['reasons']) ? (record['reasons'] as string[]) : [],
    details: (record['details'] && typeof record['details'] === 'object')
      ? (record['details'] as Record<string, unknown>)
      : {},
    ...(freshness ? { freshness } : {}),
  };
}

// ── Derived volatility helpers ───────────────────────────────────────────────

/**
 * Narrow the boundary `get_volatility` success payload (`unknown` over the wire)
 * to `VolatilityEvidence`, or null when there is no usable reading.
 *
 * D1-b rework (H1/H2): the FULL volatility derivation — absolute-units ATR plus
 * percentile-classified regime — now happens Traderton-side (the percentile
 * classification needs the full candle TR distribution, which stays behind the
 * boundary). The boundary returns `{ ok, volatilityPct, volatilityEvidence:
 * VolatilityEvidence | null, freshness? }`; this consumer passes
 * `volatilityEvidence` through VERBATIM after validating its fields. It does NOT
 * reconstruct `averageTrueRange` from the `volatilityPct` scalar (H1) and does
 * NOT invent any regime thresholds (H2). A null/absent/malformed `volatilityEvidence`
 * is a valid "insufficient data" result that maps to null (not an error).
 */
function parseVolatilityPayload(data: unknown): VolatilityEvidence | null {
  if (!data || typeof data !== 'object') {
    return null;
  }
  const evidence = (data as Record<string, unknown>)['volatilityEvidence'];
  // Validate at the system boundary with the domain schema (AGENTS.md — validate
  // at system boundaries). VolatilityEvidenceSchema pins averageTrueRange
  // (.nonnegative()), the regime enum, and calculationVersion; a null/absent/
  // malformed `volatilityEvidence` is a valid "insufficient data" result → null
  // (not an error). Passthrough VERBATIM — the shape is already the derived
  // VolatilityEvidence from Traderton (absolute-units ATR + percentile regime +
  // version '1.0.0'); this consumer does NOT reconstruct or reclassify anything.
  const parsed = VolatilityEvidenceSchema.safeParse(evidence);
  return parsed.success ? parsed.data : null;
}

/** The derived candle-series metadata the assessor needs from `score_candidate`. */
interface ScoreCandidateMetadata {
  candleWindow: { start: string; end: string } | null;
  candlesEvaluated: number;
}

/**
 * Narrow the boundary `score_candidate` success payload to the derived
 * candle-series metadata: the first/last candle timestamps and the count of
 * candles evaluated. The signal itself is not consumed by the evidence path.
 */
function parseScoreCandidateMetadata(data: unknown): ScoreCandidateMetadata {
  const record = (data ?? {}) as Record<string, unknown>;
  const rawCount = record['candlesEvaluated'];
  const candlesEvaluated =
    typeof rawCount === 'number' && Number.isFinite(rawCount) ? rawCount : 0;

  const rawWindow = record['candleWindow'];
  let candleWindow: { start: string; end: string } | null = null;
  if (rawWindow && typeof rawWindow === 'object') {
    const w = rawWindow as Record<string, unknown>;
    if (typeof w['start'] === 'string' && typeof w['end'] === 'string') {
      candleWindow = { start: w['start'], end: w['end'] };
    }
  }
  return { candleWindow, candlesEvaluated };
}

/**
 * Map a non-success boundary read into the structured `err(...)` the evidence
 * adapters return (mirrors the regime adapter's mapping). Returns `undefined`
 * for a `success` result so the caller proceeds with the payload.
 */
function boundaryFailureToErr(
  result: TradertonReadResult,
  toolName: string,
): Result<never> | undefined {
  switch (result.kind) {
    case 'success':
      return undefined;
    case 'failure':
      return err({
        code: 'assessment.candles_failed',
        message: `${toolName} failed (${result.code}): ${result.message}`,
      });
    case 'transport_error':
      return err({
        code: 'assessment.evidence_unavailable',
        message: `${toolName} boundary unreachable: ${result.message}`,
      });
    case 'in_progress':
      return err({
        code: 'assessment.evidence_unavailable',
        message: `${toolName} boundary invocation is still in progress`,
      });
  }
}

function makeAssessmentData<T>(
  data: T,
  source: string,
  provider: string,
  freshnessMs: number,
): AssessmentData<T> {
  const now = new Date().toISOString();
  return {
    data,
    source,
    provider,
    observedAt: now,
    expiresAt: new Date(Date.now() + freshnessMs).toISOString(),
  };
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * The narrow `check_regime` read-boundary port (L3 Q2 regime re-point). The
 * composition root binds a SYSTEM subject + deadline. When absent, regime
 * evidence is unavailable (no in-process candle/regime fallback).
 */
export interface CheckRegimeBoundary {
  invoke(input: { toolName: string; payload: unknown }): Promise<TradertonReadResult>;
}

/**
 * The narrow read-boundary port for DERIVED candle evidence (D1-b re-point).
 * Structurally identical to {@link CheckRegimeBoundary} — the composition root
 * binds a SYSTEM subject + deadline. Used to source volatility (`get_volatility`)
 * and candle-window/count (`score_candidate`) derived scalars behind the
 * boundary; raw candles never cross it. When absent, candle evidence returns a
 * structured unavailable error.
 */
export interface AssessmentReadBoundary {
  invoke(input: { toolName: string; payload: unknown }): Promise<TradertonReadResult>;
}

export interface CreateEvidencePortsParams {
  /**
   * The `check_regime` read boundary for regime evidence (L3 Q2). When absent,
   * regime evidence returns a structured unavailable error.
   */
  checkRegimeBoundary?: CheckRegimeBoundary;
  /**
   * The read boundary for DERIVED candle evidence (D1-b) — volatility over
   * `get_volatility` and candle-window/count over `score_candidate`. When absent,
   * candle evidence returns a structured unavailable error (no in-process
   * candle fetch).
   */
  readBoundary?: AssessmentReadBoundary;
  /** Freshness window for regime evidence (ms). Default: 5 min. */
  regimeFreshnessMs?: number;
  /** Freshness window for candle evidence (ms). Default: 5 min. */
  candleFreshnessMs?: number;
}

/**
 * Create real evidence ports backed entirely by the Traderton read boundary.
 *
 * The candle adapter sources DERIVED evidence over the boundary (D1-b):
 * volatility via `get_volatility` and candle-window/count via `score_candidate`
 * — no raw candles are fetched in-process or crossed over the boundary. The
 * regime adapter routes over the `check_regime` boundary (L3 Q2). Swap/dex
 * identities return structured unavailable.
 *
 * Liquidity and breadth are explicitly unavailable in the first shipped slice
 * per the implementation plan — no fabricated neutral values.
 */
export function createEvidencePorts(params: CreateEvidencePortsParams): AssessmentEvidencePorts {
  const {
    checkRegimeBoundary,
    readBoundary,
    regimeFreshnessMs = DEFAULT_REGIME_FRESHNESS_MS,
    candleFreshnessMs = DEFAULT_CANDLE_FRESHNESS_MS,
  } = params;

  // ── Regime adapter ────────────────────────────────────────────────────
  //
  // L3 Q2: regime evidence is evaluated over the Traderton `check_regime`
  // boundary (candles fetched behind the boundary). Same mapping the coordinator
  // uses: success → AssessmentData; failure/transport_error → err (never a
  // synthesized regime). Only orderbook/perp identities are supported.

  const regimeAdapter: AssessmentRegimeSource = {
    getRegime: async (identity: MarketAssessmentIdentity) => {
      if (!checkRegimeBoundary) {
        return err({
          code: 'assessment.evidence_unavailable',
          message: 'Regime boundary not configured',
        });
      }

      const target = identityToScannerTarget(identity);
      if (!target || target.venueType !== 'orderbook') {
        return err({
          code: 'assessment.evidence_unsupported_identity',
          message: `Regime evidence not supported for ${identity.instrumentKind} identities`,
        });
      }

      const result = await checkRegimeBoundary.invoke({
        toolName: 'check_regime',
        payload: { benchmarkSymbol: target.providerSymbol },
      });

      switch (result.kind) {
        case 'success': {
          const payload = parseRegimePayload(result.data);
          const regimeResult: RegimeResult = {
            pass: payload.pass,
            reasons: payload.reasons,
            details: payload.details as RegimeResult['details'],
          };
          const source = payload.freshness?.source === 'cache' ? 'cached-regime' : 'computed-regime';
          const provider = payload.freshness?.provider ?? 'binance';
          return ok(makeAssessmentData(regimeResult, source, provider, regimeFreshnessMs));
        }
        case 'failure':
          return err({
            code: 'assessment.regime_failed',
            message: `check_regime failed (${result.code}): ${result.message}`,
          });
        case 'transport_error':
          return err({
            code: 'assessment.evidence_unavailable',
            message: `Regime boundary unreachable: ${result.message}`,
          });
        case 'in_progress':
          return err({
            code: 'assessment.evidence_unavailable',
            message: 'Regime boundary invocation is still in progress',
          });
      }
    },
  };

  // ── Candles adapter (derived evidence over the boundary) ──────────────
  //
  // D1-b: raw candles are NEVER fetched in-process or crossed over the boundary.
  // Volatility is sourced from `get_volatility` (derived ATR%) and the
  // candle-window + count from `score_candidate` (derived series metadata). Both
  // route over the SAME read boundary. Success → derived AssessmentData;
  // failure/transport/in_progress → the same structured err(...) the regime
  // adapter uses. Only orderbook/perp identities are supported.

  const candlesAdapter: AssessmentCandleSource = {
    getCandles: async (input: {
      identity: MarketAssessmentIdentity;
      interval: CandleInterval;
      minimumCandles: number;
    }) => {
      if (!readBoundary) {
        return err({
          code: 'assessment.evidence_unavailable',
          message: 'Read boundary not configured',
        });
      }

      const target = identityToScannerTarget(input.identity);
      if (!target || target.venueType !== 'orderbook') {
        return err({
          code: 'assessment.evidence_unsupported_identity',
          message: `Candle evidence not supported for ${input.identity.instrumentKind} identities`,
        });
      }

      // Volatility (ATR%) — benchmark symbol = the identity's provider symbol.
      const volatilityResult = await readBoundary.invoke({
        toolName: 'get_volatility',
        payload: { symbol: target.providerSymbol },
      });
      const volatilityErr = boundaryFailureToErr(volatilityResult, 'get_volatility');
      if (volatilityErr) {
        return volatilityErr;
      }
      // volatilityResult.kind === 'success' guaranteed by boundaryFailureToErr.
      const volatility = parseVolatilityPayload(
        (volatilityResult as { kind: 'success'; data: unknown }).data,
      );

      // Candle-window + count — score the provider symbol; only the derived
      // series metadata is consumed (the signal is ignored by the evidence path).
      const scoreResult = await readBoundary.invoke({
        toolName: 'score_candidate',
        payload: {
          symbol: target.providerSymbol,
          instrumentId: target.providerSymbol,
          venueType: 'orderbook' as const,
          providerSymbol: target.providerSymbol,
          venue: input.identity.venueFamily,
        },
      });
      const scoreErr = boundaryFailureToErr(scoreResult, 'score_candidate');
      if (scoreErr) {
        return scoreErr;
      }
      const { candleWindow, candlesEvaluated } = parseScoreCandidateMetadata(
        (scoreResult as { kind: 'success'; data: unknown }).data,
      );

      const derived: DerivedCandleEvidence = { volatility, candleWindow, candlesEvaluated };
      return ok(makeAssessmentData(derived, 'boundary-derived', 'binance', candleFreshnessMs));
    },
  };

  // ── Liquidity adapter (explicit unavailable — first slice) ────────────

  const liquidityAdapter: AssessmentLiquiditySource = {
    getLiquidity: async (identity: MarketAssessmentIdentity) => {
      if (identity.instrumentKind === 'swap' || identity.instrumentKind === 'dex') {
        return err({
          code: 'assessment.evidence_unsupported_identity',
          message: `Liquidity evidence not supported for ${identity.instrumentKind} identities`,
        });
      }
      // First slice: venue-native orderbook data is not yet wired into the
      // evidence path. The Ticker port has bid/ask prices but no depth
      // quantities, so we cannot compute averageDepthUsd safely.
      // Use 'evidence_unavailable' (transient gap) rather than
      // 'evidence_unsupported_identity' (permanent) — orderbook/perp
      // liquidity IS supported in principle but the adapter isn't wired yet.
      return err({
        code: 'assessment.evidence_unavailable',
        message:
          'Liquidity evidence not yet wired — venue orderbook adapter not available in evidence path',
      });
    },
  };

  // ── Breadth adapter (explicit unavailable — first slice) ──────────────

  const breadthAdapter: AssessmentBreadthSource = {
    getBreadth: async (_input) => {
      const unavailable: AssessmentUnavailable = {
        reasonCode: 'assessment.breadth_not_configured',
        message: 'Breadth evidence not configured — keep explicit unavailable per first shipped slice',
        observedAt: new Date().toISOString(),
      };
      return ok(unavailable);
    },
  };

  return {
    regime: regimeAdapter,
    candles: candlesAdapter,
    liquidity: liquidityAdapter,
    breadth: breadthAdapter,
  };
}
