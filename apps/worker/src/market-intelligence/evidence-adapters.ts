import type {
  MarketAssessmentIdentity,
  AssessmentData,
  AssessmentUnavailable,
  TradertonReadResult,
} from '@herobids/domain';
import { err, ok } from '@herobids/domain';
import type { PriceCandle, RegimeResult } from '@herobids/market-data';
import type { ScannerCandleTarget } from '@herobids/strategy';
import type {
  AssessmentEvidencePorts,
  AssessmentCandleSource,
  AssessmentLiquiditySource,
  AssessmentBreadthSource,
  AssessmentRegimeSource,
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

export interface CreateEvidencePortsParams {
  /** Shared scanner candle fetcher (may be undefined when market data is not configured). */
  scannerCandleFetcher:
    | ((target: ScannerCandleTarget, interval: string, limit: number) => Promise<PriceCandle[]>)
    | undefined;
  /**
   * The `check_regime` read boundary for regime evidence (L3 Q2). When absent,
   * regime evidence returns a structured unavailable error.
   */
  checkRegimeBoundary?: CheckRegimeBoundary;
  /** Freshness window for regime evidence (ms). Default: 5 min. */
  regimeFreshnessMs?: number;
  /** Freshness window for candle evidence (ms). Default: 5 min. */
  candleFreshnessMs?: number;
}

/**
 * Create real evidence ports backed by the worker's scanner candle fetcher and
 * the Traderton `check_regime` boundary.
 *
 * The candle adapter uses the shared `scannerCandleFetcher` path for
 * orderbook/perp identities. The regime adapter routes over the `check_regime`
 * boundary (L3 Q2 — candles fetched behind the boundary). Swap/dex identities
 * return structured unavailable.
 *
 * Liquidity and breadth are explicitly unavailable in the first shipped slice
 * per the implementation plan — no fabricated neutral values.
 */
export function createEvidencePorts(params: CreateEvidencePortsParams): AssessmentEvidencePorts {
  const {
    scannerCandleFetcher,
    checkRegimeBoundary,
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

  // ── Candles adapter ───────────────────────────────────────────────────

  const candlesAdapter: AssessmentCandleSource = {
    getCandles: async (input: {
      identity: MarketAssessmentIdentity;
      interval: CandleInterval;
      minimumCandles: number;
    }) => {
      if (!scannerCandleFetcher) {
        return err({
          code: 'assessment.evidence_unavailable',
          message: 'Scanner candle fetcher not configured',
        });
      }

      const target = identityToScannerTarget(input.identity);
      if (!target) {
        return err({
          code: 'assessment.evidence_unsupported_identity',
          message: `Candle evidence not supported for ${input.identity.instrumentKind} identities`,
        });
      }

      try {
        const candles = await scannerCandleFetcher(target, input.interval, input.minimumCandles);

        return ok(
          makeAssessmentData(
            candles as ReadonlyArray<PriceCandle>,
            'binance-candles',
            'binance',
            candleFreshnessMs,
          ),
        );
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        return err({ code: 'assessment.candles_failed', message });
      }
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
